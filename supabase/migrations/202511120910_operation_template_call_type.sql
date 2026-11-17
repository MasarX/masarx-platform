-- Migration: Operation template call type
-- Purpose: Store outbound call type on operation templates and eliminate hardcoded channel logic.
-- Date: 2025-11-12

BEGIN;

ALTER TABLE operation_templates
    ADD COLUMN call_type TEXT NOT NULL DEFAULT 'provider_api'
        CHECK (call_type IN ('provider_api', 'client_webhook', 'comms_sms', 'comms_whatsapp', 'comms_email', 'comms_voice'));

COMMENT ON COLUMN operation_templates.call_type IS 'Outbound call type for jobs generated from this template (provider_api, client_webhook, comms_*).';

UPDATE operation_templates AS ot
SET call_type = CASE
        WHEN p.provider_type = 'comms' AND COALESCE(p.metadata->>'channel', '') = 'whatsapp' THEN 'comms_whatsapp'
        WHEN p.provider_type = 'comms' AND COALESCE(p.metadata->>'channel', '') = 'sms' THEN 'comms_sms'
        WHEN p.provider_type = 'comms' AND COALESCE(p.metadata->>'channel', '') = 'email' THEN 'comms_email'
        WHEN p.provider_type = 'comms' AND COALESCE(p.metadata->>'channel', '') = 'voice' THEN 'comms_voice'
        ELSE 'provider_api'
    END
FROM providers p
WHERE ot.provider_id = p.id;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_outbound_http_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_operation operation_templates%ROWTYPE;
    v_payload JSONB;
    v_provider_defaults JSONB := '{}'::jsonb;
    v_mapping_scope JSONB;
    v_headers JSONB;
    v_body JSONB;
    v_call_type TEXT;
    v_target_url TEXT;
    v_outbound_id UUID;
    v_priority INT;
    v_response workflow_handler_response;
BEGIN
    IF NOT (p_step.metadata ? 'operation_template_id') THEN
        RAISE EXCEPTION 'execute_outbound_http_v1: metadata missing operation_template_id for step %', p_step.id;
    END IF;

    SELECT *
    INTO v_operation
    FROM operation_templates
    WHERE id = (p_step.metadata->>'operation_template_id')::UUID;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_outbound_http_v1: operation template % not found for step %',
            p_step.metadata->>'operation_template_id',
            p_step.id;
    END IF;

    v_payload := safe_jsonpath_query_first(
        jsonb_build_object(
            'context', COALESCE(p_run.context, '{}'::jsonb),
            'transformed_payload', COALESCE(p_run.context->'transformed_payload', '{}'::jsonb)
        ),
        COALESCE(p_step.metadata->>'payload_path', '$.transformed_payload')
    );

    IF v_payload IS NULL THEN
        v_payload := COALESCE(p_run.context->'transformed_payload', '{}'::jsonb);
    END IF;

    IF COALESCE((p_step.metadata->>'expects_provider_defaults')::BOOLEAN, FALSE) THEN
        SELECT cached_value
        INTO v_provider_defaults
        FROM settings
        WHERE category = 'provider_defaults'
          AND scope_type = 'resource'
          AND scope_id = v_operation.provider_id
        ORDER BY last_updated DESC
        LIMIT 1;

        v_provider_defaults := COALESCE(v_provider_defaults, '{}'::jsonb);
    END IF;

    v_mapping_scope := jsonb_build_object(
        'context', COALESCE(p_run.context, '{}'::jsonb),
        'transformed_payload', COALESCE(p_run.context->'transformed_payload', '{}'::jsonb),
        'payload', COALESCE(v_payload, '{}'::jsonb),
        'provider_defaults', v_provider_defaults,
        'step', p_step.metadata,
        'operation', jsonb_build_object(
            'id', v_operation.id,
            'name', v_operation.operation_name
        )
    );

    v_headers := apply_request_mappings(
        COALESCE(v_operation.headers_template, '{}'::jsonb),
        COALESCE(v_operation.request_mappings->'headers', '{}'::jsonb),
        v_mapping_scope
    );

    v_body := apply_request_mappings(
        COALESCE(v_operation.body_template, '{}'::jsonb),
        COALESCE(v_operation.request_mappings->'body', '{}'::jsonb),
        v_mapping_scope
    );

    v_call_type := COALESCE(
        NULLIF(p_step.metadata->>'call_type', ''),
        NULLIF(v_operation.call_type, ''),
        'provider_api'
    );

    IF v_call_type NOT IN ('provider_api', 'client_webhook', 'comms_sms', 'comms_whatsapp', 'comms_email', 'comms_voice') THEN
        RAISE EXCEPTION 'execute_outbound_http_v1: unsupported call_type % for operation %', v_call_type, v_operation.id;
    END IF;

    v_target_url := COALESCE(NULLIF(p_step.metadata->>'override_url', ''), v_operation.url_template);

    v_priority := COALESCE(
        NULLIF(p_step.metadata->>'priority', '')::INT,
        90
    );

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
        correlation_id,
        workflow_run_step_id
    )
    VALUES (
        v_call_type,
        'provider',
        v_operation.provider_id,
        v_operation.method,
        v_target_url,
        v_headers,
        v_body,
        v_priority,
        p_step.max_retries,
        jsonb_build_object(
            'workflow_run_id', p_step.workflow_run_id,
            'workflow_run_step_id', p_step.id,
            'operation_template_id', v_operation.id,
            'operation_name', p_step.operation_name
        ),
        CASE
            WHEN p_run.context ? 'correlation_id' THEN (p_run.context->>'correlation_id')::UUID
            ELSE NULL
        END,
        p_step.id
    )
    RETURNING id INTO v_outbound_id;

    UPDATE workflow_run_steps
    SET operation_result = jsonb_build_object(
            'outbound_call_id', v_outbound_id,
            'headers', v_headers,
            'body', v_body
        ),
        updated_at = now()
    WHERE id = p_step.id;

    v_response.status := 'in_progress';
    v_response.operation_result := jsonb_build_object(
        'outbound_call_id', v_outbound_id,
        'headers', v_headers,
        'body', v_body
    );

    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_outbound_http_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Handler for outbound HTTP steps: enqueues outbound_calls job and returns in_progress status.';

COMMIT;

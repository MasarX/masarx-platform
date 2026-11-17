-- Migration: Phase 3 - Core Database Functions
-- Purpose: Implement the canonical set of database functions that power the worker/runtime layer.
-- Date: 2025-10-15

-- Helper: jsonb_extract_fields
CREATE OR REPLACE FUNCTION jsonb_extract_fields(
    p_source JSONB,
    p_field_mappings JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_result JSONB := '{}'::JSONB;
    v_key TEXT;
    v_path TEXT;
    v_value JSONB;
BEGIN
    IF p_source IS NULL OR p_field_mappings IS NULL THEN
        RETURN '{}'::JSONB;
    END IF;

    FOR v_key, v_path IN
        SELECT key, value::TEXT FROM jsonb_each_text(p_field_mappings)
    LOOP
        BEGIN
            v_value := jsonb_path_query_first(p_source, v_path::JSONPATH);
        EXCEPTION
            WHEN OTHERS THEN
                v_value := NULL;
        END;

        IF v_value IS NULL THEN
            v_value := 'null'::JSONB;
        END IF;

        v_result := jsonb_set(v_result, ARRAY[v_key], v_value, TRUE);
    END LOOP;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION jsonb_extract_fields(JSONB, JSONB)
    IS 'Apply JSONPath field mappings and return extracted values.';

-- Helper: apply_mapping_config
CREATE OR REPLACE FUNCTION apply_mapping_config(
    p_source JSONB,
    p_mapping_config_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_config RECORD;
    v_result JSONB := '{}'::JSONB;
BEGIN
    IF p_source IS NULL OR p_mapping_config_id IS NULL THEN
        RETURN p_source;
    END IF;

    SELECT mapping_config
    INTO v_config
    FROM mapping_configs
    WHERE id = p_mapping_config_id;

    IF NOT FOUND OR v_config.mapping_config IS NULL THEN
        RETURN p_source;
    END IF;

    IF v_config.mapping_config ? 'field_mappings' THEN
        v_result := jsonb_extract_fields(
            p_source,
            v_config.mapping_config->'field_mappings'
        );
    ELSE
        v_result := p_source;
    END IF;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION apply_mapping_config(JSONB, UUID)
    IS 'Execute mapping_config transformations and return transformed payload.';

-- =============================================================================
-- claim_pending_jobs
-- =============================================================================
CREATE OR REPLACE FUNCTION claim_pending_jobs(
    p_batch_size INT
)
RETURNS TABLE (
    job_id UUID,
    call_type TEXT,
    target_type TEXT,
    target_id UUID,
    method TEXT,
    url TEXT,
    headers JSONB,
    body JSONB,
    priority INT,
    retry_count INT,
    max_retries INT,
    correlation_id UUID,
    shipment_id UUID,
    context JSONB
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    UPDATE outbound_calls AS oc
    SET lease_expires_at = now() + interval '30 seconds'
    WHERE oc.id IN (
        SELECT oc2.id
        FROM outbound_calls oc2
        WHERE oc2.status = 'pending'
          AND (oc2.lease_expires_at IS NULL OR oc2.lease_expires_at < now())
        ORDER BY oc2.priority DESC, oc2.scheduled_at
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    )
    RETURNING oc.id, oc.call_type, oc.target_type, oc.target_id, oc.method, oc.url, oc.headers, oc.body,
              oc.priority, oc.retry_count, oc.max_retries, oc.correlation_id, oc.shipment_id, oc.context;
END;
$$;

COMMENT ON FUNCTION claim_pending_jobs(INT)
    IS 'Atomically claim pending outbound_calls rows and set lease_expires_at.';

-- =============================================================================
-- get_job_call_spec
-- =============================================================================
CREATE OR REPLACE FUNCTION get_job_call_spec(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_job RECORD;
    v_spec JSONB;
    v_template RECORD;
BEGIN
    SELECT *
    INTO v_job
    FROM outbound_calls
    WHERE id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'get_job_call_spec: job % not found', p_job_id;
    END IF;

    IF v_job.url IS NOT NULL THEN
        v_spec := jsonb_build_object(
            'url', v_job.url,
            'method', v_job.method,
            'headers', COALESCE(v_job.headers, '{}'::jsonb),
            'body', COALESCE(v_job.body, '{}'::jsonb)
        );
    ELSE
        SELECT ot.*
        INTO v_template
        FROM operation_templates ot
        WHERE ot.provider_id = v_job.target_id
          AND ot.operation_name = v_job.call_type
        LIMIT 1;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'get_job_call_spec: no operation template for job %', p_job_id;
        END IF;

        v_spec := jsonb_build_object(
            'url', v_template.url_template,
            'method', v_template.method,
            'headers', COALESCE(v_template.headers_template, '{}'::jsonb),
            'body', COALESCE(v_template.body_template, '{}'::jsonb)
        );
    END IF;

    RETURN v_spec;
END;
$$;

COMMENT ON FUNCTION get_job_call_spec(UUID)
    IS 'Return HTTP call specification for outbound_calls job, falling back to operation_templates when necessary.';

-- =============================================================================
-- store_response
-- =============================================================================
CREATE OR REPLACE FUNCTION store_response(
    p_job_id UUID,
    p_response_body JSONB,
    p_status_code INT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE outbound_calls
    SET response_body = p_response_body,
        response_status_code = p_status_code,
        response_headers = COALESCE(response_headers, '{}'::jsonb),
        completed_at = now()
    WHERE id = p_job_id;
END;
$$;

COMMENT ON FUNCTION store_response(UUID, JSONB, INT)
    IS 'Persist HTTP response body/status for outbound_calls entry.';

-- =============================================================================
-- orchestrate_webhook_processing
-- =============================================================================
CREATE OR REPLACE FUNCTION orchestrate_webhook_processing(p_webhook_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_webhook RECORD;
    v_source RECORD;
    v_transformed_payload JSONB;
BEGIN
    SELECT * INTO v_webhook FROM webhook_inbox WHERE id = p_webhook_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Webhook % not found', p_webhook_id;
    END IF;

    SELECT * INTO v_source FROM webhook_sources WHERE id = v_webhook.webhook_source_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Webhook source % not found for webhook %', v_webhook.webhook_source_id, p_webhook_id;
    END IF;

    IF v_webhook.transformed_payload IS NOT NULL THEN
        v_transformed_payload := v_webhook.transformed_payload;
    ELSE
        v_transformed_payload := apply_mapping_config(
            v_webhook.raw_payload,
            v_source.mapping_config_id
        );
    END IF;

    UPDATE webhook_inbox
    SET transformed_payload = v_transformed_payload,
        processing_status = 'succeeded',
        processed_at = now()
    WHERE id = p_webhook_id;

    v_webhook.transformed_payload := v_transformed_payload;

    RETURN jsonb_build_object(
        'status', 'succeeded',
        'webhook_id', p_webhook_id,
        'organization_id', v_source.organization_id,
        'transformed_payload', v_transformed_payload,
        'webhook', to_jsonb(v_webhook),
        'workflow_followup_actions', COALESCE(v_webhook.workflow_followup_actions, '[]'::jsonb),
        'workflow_followup_workflow_id', v_webhook.workflow_followup_workflow_id,
        'policy_settings_id', v_webhook.policy_settings_id,
        'policy_scope_type', v_webhook.policy_scope_type,
        'policy_scope_id', v_webhook.policy_scope_id,
        'policy_version', v_webhook.policy_version,
        'ack_outcome', v_webhook.ack_outcome,
        'ack_mode', v_webhook.ack_mode,
        'correlation_id', v_webhook.correlation_id
    );
END;
$$;

COMMENT ON FUNCTION orchestrate_webhook_processing(UUID)
    IS 'Execute mapping configuration and mark webhook as processed.';

-- =============================================================================
-- orchestrate_api_response_processing
-- =============================================================================
CREATE OR REPLACE FUNCTION orchestrate_api_response_processing(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_job RECORD;
BEGIN
    SELECT * INTO v_job FROM outbound_calls WHERE id = p_job_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Outbound job % not found', p_job_id;
    END IF;

    -- Placeholder: update job status based on response.
    IF v_job.response_status_code BETWEEN 200 AND 299 THEN
        RETURN jsonb_build_object('status', 'success', 'job_id', p_job_id);
    ELSE
        RETURN jsonb_build_object('status', 'error', 'job_id', p_job_id, 'error', v_job.error_message);
    END IF;
END;
$$;

COMMENT ON FUNCTION orchestrate_api_response_processing(UUID)
    IS 'Process provider response for outbound job (placeholder implementation).';

-- =============================================================================
-- Workflow helper functions
-- =============================================================================

CREATE OR REPLACE FUNCTION start_workflow_run(
    p_workflow_template_id UUID,
    p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_run_id UUID;
BEGIN
    INSERT INTO workflow_runs (
        id,
        workflow_template_id,
        workflow_template_version,
        entry_point,
        workflow_status,
        context,
        started_at,
        created_at
    )
    VALUES (
        gen_random_uuid(),
        p_workflow_template_id,
        1,
        'worker',
        'running',
        p_context,
        now(),
        now()
    )
    RETURNING id INTO v_run_id;

    RETURN v_run_id;
END;
$$;

COMMENT ON FUNCTION start_workflow_run(UUID, JSONB)
    IS 'Create a workflow_runs entry and return the run ID.';

CREATE OR REPLACE FUNCTION close_workflow_run(
    p_workflow_run_id UUID,
    p_status TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE workflow_runs
    SET workflow_status = p_status,
        completed_at = now()
    WHERE id = p_workflow_run_id;
END;
$$;

COMMENT ON FUNCTION close_workflow_run(UUID, TEXT)
    IS 'Mark workflow run complete with specified status.';

CREATE OR REPLACE FUNCTION progress_workflow_run(
    p_workflow_run_id UUID,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
    -- Placeholder: mark workflow as completed after single step.
    PERFORM close_workflow_run(p_workflow_run_id, 'completed');
    RETURN jsonb_build_object('status', 'completed', 'workflow_run_id', p_workflow_run_id);
END;
$$;

COMMENT ON FUNCTION progress_workflow_run(UUID, JSONB)
    IS 'Advance workflow run (placeholder logic completes immediately).';

CREATE OR REPLACE FUNCTION resolve_workflow_steps(p_workflow_template_id UUID)
RETURNS TABLE (
    workflow_template_step_id UUID,
    sequence_order INT,
    operation_name TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT wts.id, wts.sequence_order, wts.operation_name
    FROM workflow_template_steps wts
    WHERE wts.workflow_template_id = p_workflow_template_id
      AND wts.enabled = TRUE
    ORDER BY wts.sequence_order;
END;
$$;

COMMENT ON FUNCTION resolve_workflow_steps(UUID)
    IS 'Return enabled workflow steps for template.';

CREATE OR REPLACE FUNCTION apply_workflow_transition(
    p_workflow_run_id UUID,
    p_step_id UUID,
    p_transition_condition JSONB,
    p_operation_result JSONB
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
BEGIN
    -- Placeholder: no branching, return NULL indicating workflow complete.
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION apply_workflow_transition(UUID, UUID, JSONB, JSONB)
    IS 'Evaluate transition (placeholder returns NULL).';

CREATE OR REPLACE FUNCTION record_workflow_decision(
    p_workflow_run_id UUID,
    p_step_id UUID,
    p_payload JSONB
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_run RECORD;
    v_org UUID;
BEGIN
    SELECT wr.workflow_template_id, wt.scope_id
    INTO v_run
    FROM workflow_runs wr
    JOIN workflow_templates wt ON wt.id = wr.workflow_template_id
    WHERE wr.id = p_workflow_run_id;

    IF v_run.scope_id IS NOT NULL THEN
        v_org := v_run.scope_id;
    ELSE
        v_org := (SELECT organization_id FROM clients ORDER BY created_at ASC LIMIT 1);
    END IF;

    IF v_org IS NULL THEN
        RAISE EXCEPTION 'Unable to resolve organization for workflow decision (workflow_run_id=%)', p_workflow_run_id;
    END IF;

    PERFORM log_decision(
        p_organization_id := v_org,
        p_decision_category := 'workflow',
        p_resource_type := 'workflow_run',
        p_resource_id := p_workflow_run_id,
        p_decision_point := 'step_decision',
        p_decision_outcome := COALESCE(p_payload->>'status', 'unknown'),
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := p_payload,
        p_decision_reason := 'Workflow decision recorded'
    );
END;
$$;

COMMENT ON FUNCTION record_workflow_decision(UUID, UUID, JSONB)
    IS 'Write workflow decisions to decision_log via log_decision.';

-- =============================================================================
-- Helper: execute_workflow_followup_actions
-- =============================================================================

CREATE OR REPLACE FUNCTION execute_workflow_followup_actions(
    p_webhook_id UUID,
    p_actions JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_results JSONB := '[]'::jsonb;
    v_action JSONB;
    v_handler RECORD;
    v_result JSONB;
BEGIN
    IF p_actions IS NULL
       OR jsonb_typeof(p_actions) <> 'array'
       OR jsonb_array_length(p_actions) = 0 THEN
        RETURN v_results;
    END IF;

    FOR v_action IN
        SELECT jsonb_array_elements(p_actions)
    LOOP
        IF v_action IS NULL OR v_action->>'handler_key' IS NULL THEN
            v_results := v_results || jsonb_build_array(
                jsonb_build_object(
                    'handler_key', NULL,
                    'status', 'skipped',
                    'reason', 'missing_handler_key'
                )
            );
            CONTINUE;
        END IF;

        SELECT handler_key, function_name
        INTO v_handler
        FROM worker_action_handlers
        WHERE handler_key = v_action->>'handler_key'
          AND is_active = TRUE;

        IF NOT FOUND THEN
            v_result := jsonb_build_object(
                'handler_key', v_action->>'handler_key',
                'status', 'skipped',
                'reason', 'handler_not_registered'
            );
        ELSE
            BEGIN
                EXECUTE format('SELECT %s($1, $2, $3)', v_handler.function_name)
                INTO v_result
                USING p_webhook_id, v_action, p_context;
            EXCEPTION
                WHEN OTHERS THEN
                    v_result := jsonb_build_object(
                        'handler_key', v_action->>'handler_key',
                        'status', 'error',
                        'error', SQLERRM
                    );
            END;
        END IF;

        IF v_result IS NULL THEN
            v_result := jsonb_build_object(
                'handler_key', v_action->>'handler_key',
                'status', 'unknown'
            );
        END IF;

        v_results := v_results || jsonb_build_array(v_result);
    END LOOP;

    RETURN v_results;
END;
$$;

COMMENT ON FUNCTION execute_workflow_followup_actions(UUID, JSONB, JSONB)
    IS 'Execute configured workflow follow-up actions via worker_action_handlers registry and return action results.';

-- =============================================================================
-- Handler: start_workflow
-- =============================================================================

CREATE OR REPLACE FUNCTION worker_action_start_workflow(
    p_webhook_id UUID,
    p_action JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_template_text TEXT;
    v_template_id UUID;
    v_context JSONB := '{}'::jsonb;
    v_run_id UUID;
    v_org UUID;
    v_correlation UUID;
BEGIN
    v_template_text := COALESCE(
        p_action->>'workflow_template_id',
        p_action->'arguments'->>'workflow_template_id',
        p_context->>'workflow_followup_workflow_id'
    );

    IF v_template_text IS NULL OR trim(v_template_text) = '' THEN
        RETURN jsonb_build_object(
            'handler_key', 'start_workflow',
            'status', 'skipped',
            'reason', 'missing_workflow_template_id'
        );
    END IF;

    BEGIN
        v_template_id := v_template_text::UUID;
    EXCEPTION
        WHEN OTHERS THEN
            RETURN jsonb_build_object(
                'handler_key', 'start_workflow',
                'status', 'skipped',
                'reason', 'invalid_workflow_template_id'
            );
    END;

    IF (p_action->'arguments') ? 'context' THEN
        v_context := COALESCE(p_action->'arguments'->'context', '{}'::jsonb);
    ELSIF p_context ? 'transformed_payload' THEN
        v_context := jsonb_build_object(
            'webhook_id', p_webhook_id,
            'payload', p_context->'transformed_payload'
        );
    ELSE
        v_context := jsonb_build_object('webhook_id', p_webhook_id);
    END IF;

    v_run_id := start_workflow_run(v_template_id, v_context);

    v_org := NULL;
    IF p_context ? 'organization_id' AND (p_context->>'organization_id') <> '' THEN
        BEGIN
            v_org = (p_context->>'organization_id')::UUID;
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
            p_decision_point := 'workflow_followup_action:start_workflow',
            p_decision_outcome := 'create_job',
            p_performed_by_system := 'webhook_processor_worker',
            p_correlation_id := v_correlation,
            p_decision_inputs := jsonb_build_object(
                'action', p_action,
                'workflow_run_id', v_run_id
            ),
            p_decision_reason := NULL
        );
    END IF;

    RETURN jsonb_build_object(
        'handler_key', 'start_workflow',
        'status', 'success',
        'workflow_run_id', v_run_id
    );
END;
$$;

COMMENT ON FUNCTION worker_action_start_workflow(UUID, JSONB, JSONB)
    IS 'Kick off workflow run based on workflow follow-up configuration.';

-- =============================================================================
-- Handler: call_supplier_api
-- =============================================================================

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
        'provider_api',
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

COMMENT ON FUNCTION worker_action_call_supplier_api(UUID, JSONB, JSONB)
    IS 'Queue supplier API call via outbound_calls using configured operation template.';

-- =============================================================================
-- Handler: enqueue_notification
-- =============================================================================

CREATE OR REPLACE FUNCTION worker_action_enqueue_notification(
    p_webhook_id UUID,
    p_action JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_channel TEXT;
    v_call_type TEXT;
    v_recipient_text TEXT;
    v_recipient_id UUID;
    v_outbound_id UUID;
    v_priority INT;
    v_org UUID;
    v_correlation UUID;
BEGIN
    v_channel := lower(COALESCE(
        p_action->>'channel',
        p_action->'arguments'->>'channel'
    ));

    IF v_channel IS NULL OR v_channel NOT IN ('sms', 'whatsapp', 'email', 'voice', 'push') THEN
        RETURN jsonb_build_object(
            'handler_key', 'enqueue_notification',
            'status', 'skipped',
            'reason', 'invalid_channel'
        );
    END IF;

    v_call_type := 'comms_' || v_channel;

    v_recipient_text := COALESCE(
        p_action->'arguments'->>'recipient_id',
        p_action->>'recipient_id'
    );

    IF v_recipient_text IS NULL OR trim(v_recipient_text) = '' THEN
        RETURN jsonb_build_object(
            'handler_key', 'enqueue_notification',
            'status', 'skipped',
            'reason', 'missing_recipient_id'
        );
    END IF;

    BEGIN
        v_recipient_id := v_recipient_text::UUID;
    EXCEPTION
        WHEN OTHERS THEN
            RETURN jsonb_build_object(
                'handler_key', 'enqueue_notification',
                'status', 'skipped',
                'reason', 'invalid_recipient_id'
            );
    END;

    BEGIN
        v_priority := COALESCE((p_action->'arguments'->>'priority')::INT, 100);
    EXCEPTION
        WHEN OTHERS THEN
            v_priority := 100;
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
        'recipient',
        v_recipient_id,
        'POST',
        format('comms://%s', v_channel),
        '{}'::jsonb,
        COALESCE(p_action->'arguments'->'payload', '{}'::jsonb),
        v_priority,
        COALESCE((p_action->'arguments'->>'max_retries')::INT, 3),
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
            p_decision_point := 'workflow_followup_action:enqueue_notification',
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
        'handler_key', 'enqueue_notification',
        'status', 'queued',
        'outbound_call_id', v_outbound_id
    );
END;
$$;

COMMENT ON FUNCTION worker_action_enqueue_notification(UUID, JSONB, JSONB)
    IS 'Queue communication job based on workflow follow-up notification action.';

-- =============================================================================
-- Handler: geocode_enrich
-- =============================================================================

CREATE OR REPLACE FUNCTION worker_action_geocode_enrich(
    p_webhook_id UUID,
    p_action JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_provider_text TEXT;
    v_provider_id UUID;
    v_url TEXT;
    v_method TEXT;
    v_outbound_id UUID;
    v_org UUID;
    v_correlation UUID;
BEGIN
    v_provider_text := COALESCE(
        p_action->>'provider_id',
        p_action->'arguments'->>'provider_id'
    );

    IF v_provider_text IS NULL OR trim(v_provider_text) = '' THEN
        RETURN jsonb_build_object(
            'handler_key', 'geocode_enrich',
            'status', 'skipped',
            'reason', 'missing_provider_id'
        );
    END IF;

    BEGIN
        v_provider_id := v_provider_text::UUID;
    EXCEPTION
        WHEN OTHERS THEN
            RETURN jsonb_build_object(
                'handler_key', 'geocode_enrich',
                'status', 'skipped',
                'reason', 'invalid_provider_id'
            );
    END;

    v_url := COALESCE(
        p_action->'arguments'->>'url',
        'geocode://provider'
    );

    v_method := COALESCE(
        upper(p_action->'arguments'->>'method'),
        'POST'
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
        correlation_id
    )
    VALUES (
        'provider_api',
        'provider',
        v_provider_id,
        v_method,
        v_url,
        COALESCE(p_action->'arguments'->'headers', '{}'::jsonb),
        COALESCE(p_action->'arguments'->'payload', '{}'::jsonb),
        COALESCE((p_action->'arguments'->>'priority')::INT, 90),
        COALESCE((p_action->'arguments'->>'max_retries')::INT, 2),
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
            p_decision_point := 'workflow_followup_action:geocode_enrich',
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
        'handler_key', 'geocode_enrich',
        'status', 'queued',
        'outbound_call_id', v_outbound_id
    );
END;
$$;

COMMENT ON FUNCTION worker_action_geocode_enrich(UUID, JSONB, JSONB)
    IS 'Queue geocode enrichment call via outbound_calls.';

-- =============================================================================
-- Re-defined Worker: run_webhook_processor_worker (workflow follow-up aware)
-- =============================================================================

CREATE OR REPLACE FUNCTION run_webhook_processor_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_row RECORD;
    v_result JSONB;
    v_org UUID;
    v_action_results JSONB := '[]'::jsonb;
    v_additional_result JSONB;
    v_processing_context JSONB;
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

                PERFORM log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'webhook_processing',
                    p_resource_type := 'webhook_inbox',
                    p_resource_id := v_row.webhook_id,
                    p_decision_point := 'pre_process_guard',
                    p_decision_outcome := v_row.ack_outcome,
                    p_performed_by_system := 'webhook_processor_worker',
                    p_correlation_id := v_context,
                    p_decision_inputs := jsonb_build_object(
                        'ack_outcome', v_row.ack_outcome,
                        'ack_reason', v_row.ack_reason,
                        'policy_settings_id', v_row.policy_settings_id,
                        'policy_scope_type', v_row.policy_scope_type,
                        'policy_scope_id', v_row.policy_scope_id,
                        'policy_version', v_row.policy_version
                    ),
                    p_decision_reason := 'Skipping webhook processing because acknowledgement outcome is not ack_sent.'
                );

                PERFORM create_ops_alert_for_webhook(
                    v_org,
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
            v_org := COALESCE(
                v_row.organization_id,
                resolve_organization_id_strict('webhook_inbox', v_row.webhook_id)
            );

            v_processing_context := jsonb_build_object(
                'organization_id', v_org,
                'policy_settings_id', v_result->>'policy_settings_id',
                'policy_scope_type', v_result->>'policy_scope_type',
                'policy_scope_id', v_result->>'policy_scope_id',
                'policy_version', v_result->>'policy_version',
                'transformed_payload', v_result->'transformed_payload',
                'webhook', v_result->'webhook',
                'workflow_followup_workflow_id', v_result->'workflow_followup_workflow_id',
                'correlation_id', v_result->>'correlation_id'
            );

            v_action_results := '[]'::jsonb;

            v_action_results := execute_workflow_followup_actions(
                v_row.webhook_id,
                v_result->'workflow_followup_actions',
                v_processing_context
            );

            IF v_result->'workflow_followup_workflow_id' IS NOT NULL THEN
                IF NOT EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(COALESCE(v_result->'workflow_followup_actions', '[]'::jsonb)) elem
                    WHERE elem->>'handler_key' = 'start_workflow'
                ) THEN
                    v_additional_result := worker_action_start_workflow(
                        v_row.webhook_id,
                        jsonb_build_object('handler_key', 'start_workflow'),
                        v_processing_context
                    );
                    v_action_results := v_action_results || jsonb_build_array(v_additional_result);
                END IF;
            END IF;

            v_result := v_result || jsonb_build_object(
                'workflow_followup_action_results', v_action_results
            );

            PERFORM log_decision(
                p_organization_id := v_org,
                p_decision_category := 'webhook_processing',
                p_resource_type := 'webhook_inbox',
                p_resource_id := v_row.webhook_id,
                p_decision_point := 'process_webhook',
                p_decision_outcome := COALESCE(v_result->>'status', 'unknown'),
                p_performed_by_system := 'webhook_processor_worker',
                p_correlation_id := v_context,
                p_decision_inputs := v_result,
                p_decision_reason := 'Webhook processed via orchestrator helper.'
            );

            IF COALESCE(v_result->>'status', 'unknown') NOT IN ('completed', 'success', 'processed') THEN
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

                PERFORM log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'webhook_processing',
                    p_resource_type := 'webhook_inbox',
                    p_resource_id := v_row.webhook_id,
                    p_decision_point := 'process_webhook',
                    p_decision_outcome := 'error',
                    p_performed_by_system := 'webhook_processor_worker',
                    p_correlation_id := v_context,
                    p_decision_reason := SQLERRM
                );

                PERFORM create_ops_alert_for_webhook(
                    v_org,
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

    PERFORM complete_request_context(v_context, v_error, v_items_processed);
    PERFORM update_cron_config('webhook_processor_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'error_occurred', v_error
    );
END;
$$;

COMMENT ON FUNCTION run_webhook_processor_worker()
    IS 'Process pending webhook inbox entries with settings-driven policies and execute workflow follow-up actions.';

CREATE OR REPLACE FUNCTION plan_retry_strategy(
    p_workflow_run_id UUID,
    p_operation_result JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN jsonb_build_object(
        'retry_allowed', TRUE,
        'retry_at', now() + interval '1 minute',
        'reason', 'Default retry strategy placeholder'
    );
END;
$$;

COMMENT ON FUNCTION plan_retry_strategy(UUID, JSONB)
    IS 'Return retry strategy metadata (placeholder implementation).';

CREATE OR REPLACE FUNCTION select_fallback_operation(
    p_workflow_run_id UUID,
    p_operation_result JSONB
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION select_fallback_operation(UUID, JSONB)
    IS 'Determine fallback workflow operation (placeholder returns NULL).';

-- Migration complete.






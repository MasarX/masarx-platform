-- Migration: Workflow engine activation (runtime + RLS)
-- Purpose: Wire canonical workflow templates into runtime execution with audit + isolation (Plan.md §4.3, §5.7)
-- Date: 2025-10-16

-- =============================================================================
-- Schema adjustments
-- =============================================================================

ALTER TABLE webhook_inbox
    ADD COLUMN IF NOT EXISTS workflow_followup_workflow_run_id UUID;

ALTER TABLE outbound_calls
    ADD COLUMN IF NOT EXISTS workflow_run_step_id UUID REFERENCES workflow_run_steps(id);

CREATE INDEX IF NOT EXISTS idx_outbound_calls_workflow_step ON outbound_calls(workflow_run_step_id);

SET check_function_bodies = OFF;

-- =============================================================================
-- Helper: safe_jsonpath_query
-- =============================================================================

CREATE OR REPLACE FUNCTION safe_jsonpath_query_first(
    p_document JSONB,
    p_expression TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_result JSONB;
BEGIN
    IF p_document IS NULL OR p_expression IS NULL OR trim(p_expression) = '' THEN
        RETURN NULL;
    END IF;

    BEGIN
        v_result := jsonb_path_query_first(p_document, p_expression::jsonpath);
    EXCEPTION
        WHEN others THEN
            v_result := NULL;
    END;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION safe_jsonpath_query_first(JSONB, TEXT)
    IS 'Execute jsonpath query with error trapping; returns NULL on invalid path.';

-- =============================================================================
-- Helper: apply_request_mappings (headers/body templating)
-- =============================================================================

CREATE OR REPLACE FUNCTION apply_request_mappings(
    p_base JSONB,
    p_mappings JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_result JSONB := COALESCE(p_base, '{}'::jsonb);
    v_key TEXT;
    v_expr TEXT;
    v_value JSONB;
    v_path TEXT[];
BEGIN
    IF p_mappings IS NULL OR jsonb_typeof(p_mappings) <> 'object' THEN
        RETURN v_result;
    END IF;

    FOR v_key, v_expr IN
        SELECT key, value::TEXT
        FROM jsonb_each_text(p_mappings)
    LOOP
        v_value := safe_jsonpath_query_first(p_context, v_expr);
        IF v_value IS NULL THEN
            CONTINUE;
        END IF;

        v_path := string_to_array(v_key, '.');
        v_result := jsonb_set(v_result, v_path, v_value, TRUE);
    END LOOP;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION apply_request_mappings(JSONB, JSONB, JSONB)
    IS 'Merge jsonpath-derived values into request template (headers/body).';

-- =============================================================================
-- start_workflow_run (reimplementation)
-- =============================================================================

CREATE OR REPLACE FUNCTION start_workflow_run(
    p_workflow_template_id UUID,
    p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_template workflow_templates%ROWTYPE;
    v_run_id UUID;
    v_now TIMESTAMPTZ := now();
    v_max_retries INT;
BEGIN
    SELECT *
    INTO v_template
    FROM workflow_templates
    WHERE id = p_workflow_template_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'start_workflow_run: template % not found', p_workflow_template_id;
    END IF;

    IF v_template.status <> 'active' THEN
        RAISE EXCEPTION 'start_workflow_run: template % is not active', p_workflow_template_id;
    END IF;

    v_run_id := gen_random_uuid();

    INSERT INTO workflow_runs (
        id,
        workflow_template_id,
        workflow_template_version,
        entry_point,
        workflow_status,
        context,
        metadata,
        created_at,
        updated_at
    )
    VALUES (
        v_run_id,
        v_template.id,
        v_template.version,
        'webhook',
        'pending',
        COALESCE(p_context, '{}'::jsonb),
        jsonb_build_object('template_notes', v_template.notes),
        v_now,
        v_now
    );

    INSERT INTO workflow_run_steps (
        id,
        workflow_run_id,
        workflow_template_step_id,
        sequence_order,
        step_status,
        operation_name,
        max_retries,
        metadata,
        enqueued_at,
        created_at,
        updated_at
    )
    SELECT
        gen_random_uuid(),
        v_run_id,
        wts.id,
        wts.sequence_order,
        'pending',
        wts.operation_name,
        COALESCE(
            NULLIF(wts.metadata->>'max_retries', '')::INT,
            3
        ),
        COALESCE(wts.metadata, '{}'::jsonb),
        v_now,
        v_now,
        v_now
    FROM workflow_template_steps wts
    WHERE wts.workflow_template_id = v_template.id
      AND wts.enabled = TRUE
    ORDER BY wts.sequence_order;

    RETURN v_run_id;
END;
$$;

COMMENT ON FUNCTION start_workflow_run(UUID, JSONB)
    IS 'Create workflow run + step records for active template; returns workflow_run_id.';

-- =============================================================================
-- progress_workflow_run (execute next pending step)
-- =============================================================================

CREATE OR REPLACE FUNCTION progress_workflow_run(
    p_workflow_run_id UUID,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_run workflow_runs%ROWTYPE;
    v_step workflow_run_steps%ROWTYPE;
    v_operation operation_templates%ROWTYPE;
    v_now TIMESTAMPTZ := now();
    v_shipment_id UUID;
    v_shipment_box_id UUID;
    v_label_type TEXT;
    v_label_job_id UUID;
    v_poll_seconds INT;
    v_max_wait_seconds INT;
    v_total_wait INT;
    v_job_id UUID;
    v_label_record RECORD;
    v_payload JSONB;
    v_provider_defaults JSONB := '{}'::jsonb;
    v_mapping_scope JSONB;
    v_headers JSONB;
    v_body JSONB;
    v_outbound_id UUID;
    v_status TEXT := 'pending';
    v_priority INT;
    v_result JSONB;
    v_completed BOOLEAN := FALSE;
    v_error TEXT;
BEGIN
    SELECT *
    INTO v_run
    FROM workflow_runs
    WHERE id = p_workflow_run_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'progress_workflow_run: workflow % not found', p_workflow_run_id;
    END IF;

    IF v_run.workflow_status IN ('completed', 'failed', 'cancelled') THEN
        RETURN jsonb_build_object(
            'workflow_run_id', p_workflow_run_id,
            'status', v_run.workflow_status
        );
    END IF;

    SELECT *
    INTO v_step
    FROM workflow_run_steps
    WHERE workflow_run_id = p_workflow_run_id
      AND step_status = 'pending'
    ORDER BY sequence_order
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        UPDATE workflow_runs
        SET workflow_status = 'completed',
            current_step_id = NULL,
            completed_at = COALESCE(completed_at, v_now),
            updated_at = v_now
        WHERE id = p_workflow_run_id;

        RETURN jsonb_build_object(
            'workflow_run_id', p_workflow_run_id,
            'status', 'completed'
        );
    END IF;

    UPDATE workflow_runs
    SET workflow_status = 'in_progress',
        current_step_id = v_step.workflow_template_step_id,
        started_at = COALESCE(started_at, v_now),
        updated_at = v_now
    WHERE id = p_workflow_run_id;

    UPDATE workflow_run_steps
    SET step_status = 'in_progress',
        operation_started_at = v_now,
        updated_at = v_now
    WHERE id = v_step.id;

    IF v_step.operation_name = 'generate_label_job' THEN
        v_label_type := COALESCE(NULLIF(v_step.metadata->>'label_type', ''), 'shipping');

        v_shipment_id := COALESCE(
            NULLIF(v_run.context->>'shipment_id', '')::UUID,
            NULLIF(v_run.context->'transformed_payload'->>'shipment_id', '')::UUID,
            NULLIF(v_run.context->'transformed_payload'->'shipment'->>'id', '')::UUID,
            NULLIF(v_run.context->'shipment'->>'id', '')::UUID
        );

        v_shipment_box_id := COALESCE(
            NULLIF(v_run.context->>'shipment_box_id', '')::UUID,
            NULLIF(v_run.context->'transformed_payload'->>'shipment_box_id', '')::UUID,
            NULLIF(v_run.context->'transformed_payload'->'box'->>'id', '')::UUID,
            NULLIF(v_run.context->'shipment_box'->>'id', '')::UUID
        );

        IF v_shipment_id IS NULL THEN
            RAISE EXCEPTION 'generate_label_job: shipment_id not available in workflow context for run %', p_workflow_run_id;
        END IF;

        v_job_id := request_label_generation(
            v_shipment_id,
            v_label_type,
            NULL,
            COALESCE(NULLIF(v_step.metadata->>'requested_source', ''), 'workflow'),
            v_shipment_box_id,
            COALESCE(NULLIF(v_step.metadata->>'job_purpose', ''), 'primary')
        );

        UPDATE workflow_run_steps
        SET step_status = 'completed',
            operation_completed_at = now(),
            duration_ms = COALESCE(
                duration_ms,
                GREATEST(0, (extract(epoch FROM now() - v_now) * 1000)::INT)
            ),
            operation_result = jsonb_build_object(
                'status', 'queued',
                'label_job_id', v_job_id,
                'label_type', v_label_type,
                'shipment_id', v_shipment_id,
                'shipment_box_id', v_shipment_box_id
            ),
            updated_at = now()
        WHERE id = v_step.id;

        UPDATE workflow_runs
        SET context = jsonb_set(
                COALESCE(context, '{}'::jsonb),
                '{label_jobs}',
                COALESCE(
                    context -> 'label_jobs',
                    '[]'::jsonb
                ) || jsonb_build_object(
                    'label_job_id', v_job_id,
                    'label_type', v_label_type,
                    'workflow_step_id', v_step.workflow_template_step_id,
                    'created_at', now()
                ),
                TRUE
            ),
            updated_at = now()
        WHERE id = p_workflow_run_id;

        RETURN jsonb_build_object(
            'workflow_run_id', p_workflow_run_id,
            'status', 'in_progress',
            'label_job_id', v_job_id
        );
    END IF;

    IF v_step.operation_name = 'wait_for_label_job' THEN
        SELECT
            (operation_result->>'label_job_id')::UUID
        INTO v_label_job_id
        FROM workflow_run_steps
        WHERE workflow_run_id = p_workflow_run_id
          AND sequence_order < v_step.sequence_order
          AND operation_name = 'generate_label_job'
        ORDER BY sequence_order DESC
        LIMIT 1;

        IF v_label_job_id IS NULL THEN
            v_label_job_id := NULLIF(v_step.metadata->>'label_job_id', '')::UUID;
        END IF;

        IF v_label_job_id IS NULL THEN
            RAISE EXCEPTION 'wait_for_label_job: label_job_id not found in workflow context for run %', p_workflow_run_id;
        END IF;

        SELECT *
        INTO v_label_record
        FROM label_jobs
        WHERE id = v_label_job_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'wait_for_label_job: label job % missing for workflow run %', v_label_job_id, p_workflow_run_id;
        END IF;

        v_poll_seconds := COALESCE(NULLIF(v_step.metadata->>'poll_interval_seconds', '')::INT, 60);
        v_max_wait_seconds := COALESCE(NULLIF(v_step.metadata->>'max_wait_seconds', '')::INT, 900);
        v_total_wait := GREATEST(0, (extract(epoch FROM (v_now - v_step.enqueued_at)))::INT);

        IF v_label_record.status = 'succeeded' THEN
            UPDATE workflow_run_steps
            SET step_status = 'completed',
                operation_completed_at = now(),
                duration_ms = GREATEST(0, (extract(epoch FROM now() - v_now) * 1000)::INT),
                operation_result = jsonb_build_object(
                    'status', v_label_record.status,
                    'label_job_id', v_label_record.id,
                    'file_url', v_label_record.output_file_url,
                    'renderer_metadata', v_label_record.renderer_metadata
                ),
                updated_at = now()
            WHERE id = v_step.id;

            RETURN jsonb_build_object(
                'workflow_run_id', p_workflow_run_id,
                'status', 'in_progress',
                'label_job_status', 'succeeded'
            );
        ELSIF v_label_record.status = 'failed' THEN
            UPDATE workflow_run_steps
            SET step_status = 'failed',
                operation_completed_at = now(),
                last_error = COALESCE(v_label_record.error_reason, 'label_generation_failed'),
                operation_result = jsonb_build_object(
                    'status', v_label_record.status,
                    'label_job_id', v_label_record.id,
                    'error_reason', v_label_record.error_reason
                ),
                updated_at = now()
            WHERE id = v_step.id;

            UPDATE workflow_runs
            SET workflow_status = 'failed',
                updated_at = now()
            WHERE id = p_workflow_run_id;

            RETURN jsonb_build_object(
                'workflow_run_id', p_workflow_run_id,
                'status', 'failed',
                'label_job_status', 'failed'
            );
        ELSIF v_total_wait >= v_max_wait_seconds THEN
            UPDATE workflow_run_steps
            SET step_status = 'failed',
                operation_completed_at = now(),
                last_error = 'label_generation_timeout',
                operation_result = jsonb_build_object(
                    'status', v_label_record.status,
                    'label_job_id', v_label_record.id,
                    'error_reason', 'timeout'
                ),
                updated_at = now()
            WHERE id = v_step.id;

            UPDATE workflow_runs
            SET workflow_status = 'failed',
                updated_at = now()
            WHERE id = p_workflow_run_id;

            RETURN jsonb_build_object(
                'workflow_run_id', p_workflow_run_id,
                'status', 'failed',
                'label_job_status', 'timeout'
            );
        ELSE
            UPDATE workflow_run_steps
            SET step_status = 'pending',
                run_at = now() + make_interval(secs => GREATEST(v_poll_seconds, 15)),
                operation_started_at = NULL,
                retry_attempt = LEAST(retry_attempt + 1, max_retries),
                operation_result = jsonb_build_object(
                    'status', v_label_record.status,
                    'label_job_id', v_label_record.id,
                    'next_poll_seconds', GREATEST(v_poll_seconds, 15)
                ),
                updated_at = now()
            WHERE id = v_step.id;

            RETURN jsonb_build_object(
                'workflow_run_id', p_workflow_run_id,
                'status', 'pending',
                'label_job_status', v_label_record.status
            );
        END IF;
    END IF;

    IF v_step.operation_name = 'record_workflow_completion' THEN
        UPDATE workflow_run_steps
        SET step_status = 'completed',
            operation_completed_at = now(),
            duration_ms = 0,
            operation_result = jsonb_build_object('status', 'completed'),
            updated_at = now()
        WHERE id = v_step.id;

        UPDATE workflow_runs
        SET workflow_status = 'completed',
            current_step_id = NULL,
            completed_at = COALESCE(completed_at, now()),
            updated_at = now()
        WHERE id = p_workflow_run_id;

        RETURN jsonb_build_object(
            'workflow_run_id', p_workflow_run_id,
            'status', 'completed'
        );
    END IF;

    IF NOT (v_step.metadata ? 'operation_template_id') THEN
        RAISE EXCEPTION 'progress_workflow_run: metadata missing operation_template_id for step %', v_step.id;
    END IF;

    SELECT *
    INTO v_operation
    FROM operation_templates
    WHERE id = (v_step.metadata->>'operation_template_id')::UUID;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'progress_workflow_run: operation template % not found for step %',
            v_step.metadata->>'operation_template_id',
            v_step.id;
    END IF;

    -- Determine payload for mapping scope
    v_payload := safe_jsonpath_query_first(
        jsonb_build_object(
            'context', COALESCE(v_run.context, '{}'::jsonb),
            'transformed_payload', COALESCE(v_run.context->'transformed_payload', '{}'::jsonb)
        ),
        COALESCE(v_step.metadata->>'payload_path', '$.transformed_payload')
    );

    IF v_payload IS NULL THEN
        v_payload := COALESCE(v_run.context->'transformed_payload', '{}'::jsonb);
    END IF;

    -- Provider defaults (optional)
    IF COALESCE((v_step.metadata->>'expects_provider_defaults')::BOOLEAN, FALSE) THEN
        SELECT cached_value
        INTO v_provider_defaults
        FROM settings
        WHERE category = 'provider_logestechs_defaults'
          AND scope_type = 'resource'
          AND scope_id = v_operation.provider_id
        ORDER BY last_updated DESC
        LIMIT 1;

        v_provider_defaults := COALESCE(v_provider_defaults, '{}'::jsonb);
    END IF;

    v_mapping_scope := jsonb_build_object(
        'context', COALESCE(v_run.context, '{}'::jsonb),
        'transformed_payload', COALESCE(v_run.context->'transformed_payload', '{}'::jsonb),
        'payload', COALESCE(v_payload, '{}'::jsonb),
        'provider_defaults', v_provider_defaults,
        'step', v_step.metadata,
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

    v_priority := COALESCE(
        NULLIF(v_step.metadata->>'priority', '')::INT,
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
        CASE
            WHEN v_step.operation_name = 'enqueue_notification' THEN 'comms_whatsapp'
            ELSE 'provider_api'
        END,
        'provider',
        v_operation.provider_id,
        v_operation.method,
        v_operation.url_template,
        v_headers,
        v_body,
        v_priority,
        v_step.max_retries,
        jsonb_build_object(
            'workflow_run_id', p_workflow_run_id,
            'workflow_run_step_id', v_step.id,
            'operation_template_id', v_operation.id,
            'operation_name', v_step.operation_name
        ),
        CASE
            WHEN v_run.context ? 'correlation_id' THEN (v_run.context->>'correlation_id')::UUID
            ELSE NULL
        END,
        v_step.id
    )
    RETURNING id INTO v_outbound_id;

    UPDATE workflow_run_steps
    SET operation_result = jsonb_build_object(
            'outbound_call_id', v_outbound_id,
            'headers', v_headers,
            'body', v_body
        ),
        updated_at = now()
    WHERE id = v_step.id;

    v_status := 'in_progress';
    v_result := jsonb_build_object(
        'workflow_run_id', p_workflow_run_id,
        'step_id', v_step.id,
        'status', v_status,
        'outbound_call_id', v_outbound_id
    );

    RETURN v_result;
EXCEPTION
    WHEN OTHERS THEN
        v_error := SQLERRM;

        UPDATE workflow_run_steps
        SET step_status = 'failed',
            last_error = v_error,
            updated_at = now()
        WHERE id = v_step.id;

        UPDATE workflow_runs
        SET workflow_status = 'failed',
            failure_reason = v_error,
            last_error = jsonb_build_object('error', v_error),
            updated_at = now()
        WHERE id = p_workflow_run_id;

        RETURN jsonb_build_object(
            'workflow_run_id', p_workflow_run_id,
            'status', 'failed',
            'error', v_error
        );
END;
$$;

COMMENT ON FUNCTION progress_workflow_run(UUID, JSONB)
    IS 'Progress workflow by enqueuing next step; returns status + outbound call id if queued.';

-- =============================================================================
-- Apply transition (placeholder -> handled within runtime functions)
-- =============================================================================

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
    -- Transition handling performed in progress_workflow_run/store_response; no branching yet.
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION apply_workflow_transition(UUID, UUID, JSONB, JSONB)
    IS 'Transition handler (no-op placeholder; branching handled in runtime functions).';

-- =============================================================================
-- Update worker_action_start_workflow to persist run id
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

    v_context := COALESCE(p_context, '{}'::jsonb);
    v_context := jsonb_set(
        v_context,
        '{webhook_id}',
        to_jsonb(p_webhook_id),
        TRUE
    );

    v_run_id := start_workflow_run(v_template_id, v_context);

    UPDATE webhook_inbox
    SET workflow_followup_workflow_run_id = v_run_id
    WHERE id = p_webhook_id;

    v_org := NULL;
    IF p_context ? 'organization_id' THEN
        BEGIN
            v_org := (p_context->>'organization_id')::UUID;
        EXCEPTION
            WHEN OTHERS THEN
                v_org := NULL;
        END;
    END IF;

    v_correlation := NULL;
    IF p_context ? 'correlation_id' THEN
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
            p_decision_outcome := 'workflow_started',
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
    IS 'Start workflow and persist workflow_run_id on webhook_inbox.';

-- =============================================================================
-- Update store_response to close workflow steps
-- =============================================================================

CREATE OR REPLACE FUNCTION store_response(
    p_job_id UUID,
    p_response_body JSONB,
    p_status_code INT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_step_id UUID;
    v_run_id UUID;
    v_step workflow_run_steps%ROWTYPE;
    v_now TIMESTAMPTZ := now();
    v_success BOOLEAN;
BEGIN
    UPDATE outbound_calls
    SET response_body = p_response_body,
        response_status_code = p_status_code,
        response_headers = COALESCE(response_headers, '{}'::jsonb),
        completed_at = v_now
    WHERE id = p_job_id
    RETURNING workflow_run_step_id INTO v_step_id;

    IF v_step_id IS NULL THEN
        RETURN;
    END IF;

    SELECT *
    INTO v_step
    FROM workflow_run_steps
    WHERE id = v_step_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    v_success := p_status_code BETWEEN 200 AND 299;

    UPDATE workflow_run_steps
    SET step_status = CASE WHEN v_success THEN 'completed' ELSE 'failed' END,
        operation_completed_at = v_now,
        duration_ms = CASE
            WHEN operation_started_at IS NOT NULL THEN
                GREATEST(
                    FLOOR(EXTRACT(EPOCH FROM (v_now - operation_started_at)) * 1000)::INT,
                    0
                )
            ELSE
                NULL
        END,
        operation_result = jsonb_build_object(
            'response_status_code', p_status_code,
            'response_body', p_response_body
        ),
        last_error = CASE
            WHEN v_success THEN NULL
            ELSE format('HTTP %s response for outbound job %s', p_status_code, p_job_id)
        END,
        updated_at = v_now
    WHERE id = v_step_id
    RETURNING workflow_run_id INTO v_run_id;

    IF v_run_id IS NULL THEN
        RETURN;
    END IF;

    IF v_success THEN
        PERFORM progress_workflow_run(v_run_id);
    ELSE
        UPDATE workflow_runs
        SET workflow_status = 'failed',
            failure_reason = 'workflow_step_failed',
            last_error = jsonb_build_object(
                'workflow_run_step_id', v_step_id,
                'status_code', p_status_code,
                'response', p_response_body
            ),
            updated_at = v_now
        WHERE id = v_run_id;
    END IF;
END;
$$;

COMMENT ON FUNCTION store_response(UUID, JSONB, INT)
    IS 'Persist outbound response and advance/terminate related workflow steps.';

-- =============================================================================
-- Refresh orchestrate_webhook_processing to expose workflow_run_id
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
        'workflow_followup_workflow_run_id', v_webhook.workflow_followup_workflow_run_id,
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
    IS 'Execute mapping configuration, mark webhook processed, and surface workflow linkage.';

-- =============================================================================
-- RLS policies for workflow tables
-- =============================================================================

ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_run_steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_runs_service_policy ON workflow_runs;
CREATE POLICY workflow_runs_service_policy ON workflow_runs
    FOR ALL
    TO service_role
    USING (TRUE)
    WITH CHECK (TRUE);

DROP POLICY IF EXISTS workflow_run_steps_service_policy ON workflow_run_steps;
CREATE POLICY workflow_run_steps_service_policy ON workflow_run_steps
    FOR ALL
    TO service_role
    USING (TRUE)
    WITH CHECK (TRUE);

DROP POLICY IF EXISTS workflow_runs_isolation_policy ON workflow_runs;
CREATE POLICY workflow_runs_isolation_policy ON workflow_runs
    FOR SELECT
    TO authenticated
    USING (
        COALESCE((context->>'organization_id')::UUID, current_user_org_id()) = current_user_org_id()
    );

DROP POLICY IF EXISTS workflow_run_steps_isolation_policy ON workflow_run_steps;
CREATE POLICY workflow_run_steps_isolation_policy ON workflow_run_steps
    FOR SELECT
    TO authenticated
    USING (
        workflow_run_id IN (
            SELECT id
            FROM workflow_runs
            WHERE COALESCE((context->>'organization_id')::UUID, current_user_org_id()) = current_user_org_id()
        )
    );

-- =============================================================================
-- Re-define run_webhook_processor_worker to progress workflows
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
    v_workflow_progress_count INT := 0;
    v_action JSONB;
    v_pending_run RECORD;
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

            -- progress any workflows started via configured actions
            FOR v_action IN
                SELECT elem
                FROM jsonb_array_elements(v_action_results) elem
                WHERE elem->>'workflow_run_id' IS NOT NULL
            LOOP
                PERFORM progress_workflow_run((v_action->>'workflow_run_id')::UUID);
                v_workflow_progress_count := v_workflow_progress_count + 1;
            END LOOP;

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

                    IF v_additional_result ? 'workflow_run_id' THEN
                        PERFORM progress_workflow_run((v_additional_result->>'workflow_run_id')::UUID);
                        v_workflow_progress_count := v_workflow_progress_count + 1;
                    END IF;
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

    -- Progress lingering workflows (safety net)
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
$$;

COMMENT ON FUNCTION run_webhook_processor_worker()
    IS 'Process webhook inbox rows, execute workflow follow-up actions, and advance queued workflows.';

SET check_function_bodies = ON;

-- =============================================================================
-- Migration complete
-- =============================================================================



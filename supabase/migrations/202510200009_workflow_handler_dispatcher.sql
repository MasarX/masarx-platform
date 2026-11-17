-- Migration: Workflow handler dispatcher refactor
-- Purpose: Introduce handler execution framework and refactor workflow dispatcher.
-- Date: 2025-10-20

BEGIN;

CREATE SCHEMA IF NOT EXISTS workflow_handlers;
COMMENT ON SCHEMA workflow_handlers IS 'Dedicated schema for workflow operation handler functions.';

DROP TYPE IF EXISTS workflow_handler_response CASCADE;
CREATE TYPE workflow_handler_response AS (
    status TEXT,
    workflow_status TEXT,
    next_run_at TIMESTAMPTZ,
    operation_result JSONB,
    context_patch JSONB,
    last_error TEXT,
    retry_attempt INT,
    max_retries INT
);

COMMENT ON TYPE workflow_handler_response IS 'Standard response contract returned by workflow handlers.';

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
        WHERE category = 'provider_logestechs_defaults'
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
        CASE
            WHEN p_step.operation_name = 'enqueue_notification' THEN 'comms_whatsapp'
            ELSE 'provider_api'
        END,
        'provider',
        v_operation.provider_id,
        v_operation.method,
        v_operation.url_template,
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
        )
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

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_job_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_action TEXT := COALESCE(NULLIF(v_metadata->>'action', ''), CASE
        WHEN p_step.operation_name = 'wait_for_label_job' THEN 'wait'
        ELSE 'enqueue'
    END);
    v_label_type TEXT;
    v_shipment_id UUID;
    v_shipment_box_id UUID;
    v_label_job_id UUID;
    v_label_record label_jobs%ROWTYPE;
    v_poll_seconds INT;
    v_max_wait_seconds INT;
    v_total_wait INT;
    v_now TIMESTAMPTZ := now();
    v_context JSONB;
    v_response workflow_handler_response;
    v_label_jobs JSONB;
BEGIN
    IF v_action = 'enqueue' THEN
        v_label_type := COALESCE(NULLIF(v_metadata->>'label_type', ''), 'shipping');

        v_shipment_id := COALESCE(
            NULLIF(p_run.context->>'shipment_id', '')::UUID,
            NULLIF(p_run.context->'transformed_payload'->>'shipment_id', '')::UUID,
            NULLIF(p_run.context->'transformed_payload'->'shipment'->>'id', '')::UUID,
            NULLIF(p_run.context->'shipment'->>'id', '')::UUID
        );

        v_shipment_box_id := COALESCE(
            NULLIF(p_run.context->>'shipment_box_id', '')::UUID,
            NULLIF(p_run.context->'transformed_payload'->>'shipment_box_id', '')::UUID,
            NULLIF(p_run.context->'transformed_payload'->'box'->>'id', '')::UUID,
            NULLIF(p_run.context->'shipment_box'->>'id', '')::UUID
        );

        IF v_shipment_id IS NULL THEN
            RAISE EXCEPTION 'execute_label_job_v1: shipment_id not available in workflow context for run %', p_step.workflow_run_id;
        END IF;

        v_label_job_id := request_label_generation(
            v_shipment_id,
            v_label_type,
            NULL,
            COALESCE(NULLIF(v_metadata->>'requested_source', ''), 'workflow'),
            v_shipment_box_id,
            COALESCE(NULLIF(v_metadata->>'job_purpose', ''), 'primary')
        );

        v_label_jobs := COALESCE(p_run.context->'label_jobs', '[]'::jsonb)
            || jsonb_build_object(
                'label_job_id', v_label_job_id,
                'label_type', v_label_type,
                'workflow_step_id', p_step.workflow_template_step_id,
                'created_at', v_now
            );

        v_context := jsonb_set(
            COALESCE(p_run.context, '{}'::jsonb),
            '{label_jobs}',
            v_label_jobs,
            TRUE
        );

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'status', 'queued',
            'label_job_id', v_label_job_id,
            'label_type', v_label_type,
            'shipment_id', v_shipment_id,
            'shipment_box_id', v_shipment_box_id
        );
        v_response.context_patch := v_context;

        RETURN v_response;
    END IF;

    IF v_action <> 'wait' THEN
        RAISE EXCEPTION 'execute_label_job_v1: unsupported action %', v_action;
    END IF;

    SELECT (operation_result->>'label_job_id')::UUID
    INTO v_label_job_id
    FROM workflow_run_steps
    WHERE workflow_run_id = p_step.workflow_run_id
      AND sequence_order < p_step.sequence_order
      AND operation_name = 'generate_label_job'
    ORDER BY sequence_order DESC
    LIMIT 1;

    IF v_label_job_id IS NULL THEN
        v_label_job_id := NULLIF(v_metadata->>'label_job_id', '')::UUID;
    END IF;

    IF v_label_job_id IS NULL THEN
        RAISE EXCEPTION 'execute_label_job_v1: label_job_id not found for run %', p_step.workflow_run_id;
    END IF;

    SELECT *
    INTO v_label_record
    FROM label_jobs
    WHERE id = v_label_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_label_job_v1: label job % missing for workflow run %', v_label_job_id, p_step.workflow_run_id;
    END IF;

    v_poll_seconds := COALESCE(NULLIF(v_metadata->>'poll_interval_seconds', '')::INT, 60);
    v_max_wait_seconds := COALESCE(NULLIF(v_metadata->>'max_wait_seconds', '')::INT, 900);
    v_total_wait := GREATEST(0, (extract(epoch FROM (v_now - p_step.enqueued_at)))::INT);

    IF v_label_record.status = 'succeeded' THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'status', v_label_record.status,
            'label_job_id', v_label_record.id,
            'file_url', v_label_record.output_file_url,
            'renderer_metadata', v_label_record.renderer_metadata
        );
        RETURN v_response;
    ELSIF v_label_record.status = 'failed' THEN
        v_response.status := 'failed';
        v_response.workflow_status := 'failed';
        v_response.last_error := COALESCE(v_label_record.error_reason, 'label_generation_failed');
        v_response.operation_result := jsonb_build_object(
            'status', v_label_record.status,
            'label_job_id', v_label_record.id,
            'error_reason', v_label_record.error_reason
        );
        RETURN v_response;
    ELSIF v_total_wait >= v_max_wait_seconds THEN
        v_response.status := 'failed';
        v_response.workflow_status := 'failed';
        v_response.last_error := 'label_generation_timeout';
        v_response.operation_result := jsonb_build_object(
            'status', v_label_record.status,
            'label_job_id', v_label_record.id,
            'error_reason', 'timeout'
        );
        RETURN v_response;
    ELSE
        v_response.status := 'pending';
        v_response.next_run_at := v_now + make_interval(secs => GREATEST(v_poll_seconds, 15));
        v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
        v_response.operation_result := jsonb_build_object(
            'status', v_label_record.status,
            'label_job_id', v_label_record.id,
            'next_poll_seconds', GREATEST(v_poll_seconds, 15)
        );
        RETURN v_response;
    END IF;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_job_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Handler for label workflow steps (enqueue + wait logic with polling semantics).';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_workflow_control_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_action TEXT := COALESCE(NULLIF(v_metadata->>'action', ''), 'complete');
    v_response workflow_handler_response;
BEGIN
    IF v_action = 'complete' THEN
        v_response.status := 'completed';
        v_response.workflow_status := 'completed';
        v_response.operation_result := jsonb_build_object('status', 'completed');
        RETURN v_response;
    END IF;

    RAISE EXCEPTION 'execute_workflow_control_v1: unsupported action %', v_action;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_workflow_control_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Workflow control handler (e.g., mark workflow completed).';

CREATE OR REPLACE FUNCTION validate_operation_handler_signature()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_proc REGPROCEDURE;
BEGIN
    v_proc := to_regprocedure(format('%I.%I%s', NEW.handler_schema, NEW.handler_name, NEW.handler_signature));
    IF v_proc IS NULL THEN
        RAISE EXCEPTION 'operation handler %I.%I%s not found or signature mismatch',
            NEW.handler_schema,
            NEW.handler_name,
            NEW.handler_signature;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS operation_handlers_validate_signature ON operation_handlers;
CREATE TRIGGER operation_handlers_validate_signature
    BEFORE INSERT OR UPDATE ON operation_handlers
    FOR EACH ROW
    EXECUTE FUNCTION validate_operation_handler_signature();

UPDATE operation_handlers
SET updated_at = now()
WHERE handler_key IN ('outbound_http', 'label_job', 'workflow_control');

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
    v_handler_key TEXT;
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
        handler_key,
        handler_version,
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
            (resolve_settings('workflow_defaults','global', NULL)->>'max_retries')::INT
        ),
        COALESCE(wts.metadata, '{}'::jsonb),
        COALESCE(
            NULLIF(wts.handler_key, ''),
            CASE
                WHEN wts.operation_settings_category = 'operation_template' THEN 'outbound_http'
                ELSE NULL
            END
        ),
        COALESCE(NULLIF(wts.handler_version, ''), 'v1'),
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
    v_template_step workflow_template_steps%ROWTYPE;
    v_handler operation_handlers%ROWTYPE;
    v_handler_key TEXT;
    v_response workflow_handler_response;
    v_response_json JSONB;
    v_step_status TEXT;
    v_now TIMESTAMPTZ := now();
    v_error TEXT;
    v_context JSONB;
    v_duration_ms INT;
    v_next_run_at TIMESTAMPTZ;
    v_retry_attempt INT;
    v_operation_result JSONB;
    v_proc REGPROCEDURE;
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

    SELECT *
    INTO v_template_step
    FROM workflow_template_steps
    WHERE id = v_step.workflow_template_step_id;

    v_handler_key := COALESCE(
        NULLIF(v_step.handler_key, ''),
        NULLIF(v_template_step.handler_key, ''),
        CASE
            WHEN v_template_step.operation_settings_category = 'operation_template' THEN 'outbound_http'
            ELSE NULL
        END
    );

    IF v_handler_key IS NULL THEN
        RAISE EXCEPTION 'progress_workflow_run: handler_key unresolved for step %', v_step.id;
    END IF;

    SELECT *
    INTO v_handler
    FROM operation_handlers
    WHERE handler_key = v_handler_key
      AND is_active = TRUE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'progress_workflow_run: handler % not registered or inactive', v_handler_key;
    END IF;

    v_proc := to_regprocedure(format('%I.%I%s', v_handler.handler_schema, v_handler.handler_name, v_handler.handler_signature));
    IF v_proc IS NULL THEN
        RAISE EXCEPTION 'progress_workflow_run: handler function %I.%I%s missing',
            v_handler.handler_schema,
            v_handler.handler_name,
            v_handler.handler_signature;
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
        handler_key = v_handler_key,
        handler_version = v_handler.handler_version,
        updated_at = v_now
    WHERE id = v_step.id;

    v_step.step_status := 'in_progress';
    v_step.handler_key := v_handler_key;
    v_step.handler_version := v_handler.handler_version;
    v_step.operation_started_at := v_now;

    EXECUTE format('SELECT %I.%I($1,$2,$3)', v_handler.handler_schema, v_handler.handler_name)
    INTO v_response
    USING v_step, v_run, p_operation_result;

    v_response_json := to_jsonb(v_response);

    IF v_response_json->>'status' IS NULL OR btrim(v_response_json->>'status') = '' THEN
        RAISE EXCEPTION 'progress_workflow_run: handler % returned NULL status', v_handler_key;
    END IF;

    v_step_status := lower(btrim(v_response_json->>'status'));
    v_step_status := translate(v_step_status, '\"()', '');
    IF v_step_status = '' THEN
        RAISE EXCEPTION 'progress_workflow_run: handler % returned NULL status', v_handler_key;
    END IF;
    IF v_step_status LIKE 'pending%' THEN
        v_step_status := 'pending';
    ELSIF v_step_status LIKE 'in_progress%' THEN
        v_step_status := 'in_progress';
    ELSIF v_step_status LIKE 'completed%' THEN
        v_step_status := 'completed';
    ELSIF v_step_status LIKE 'failed%' THEN
        v_step_status := 'failed';
    ELSE
        RAISE EXCEPTION 'progress_workflow_run: handler % returned invalid status %', v_handler_key, v_response_json->>'status';
    END IF;

    v_operation_result := COALESCE(v_response_json->'operation_result', p_operation_result);
    v_retry_attempt := COALESCE(
        (v_response_json->>'retry_attempt')::INT,
        LEAST(v_step.retry_attempt + 1, v_step.max_retries)
    );
    v_next_run_at := (v_response_json->>'next_run_at')::TIMESTAMPTZ;

    IF v_response_json->'context_patch' IS NOT NULL
       AND jsonb_typeof(v_response_json->'context_patch') = 'object' THEN
        v_context := COALESCE(v_run.context, '{}'::jsonb) || (v_response_json->'context_patch');
    ELSE
        v_context := COALESCE(v_run.context, '{}'::jsonb);
    END IF;

    IF v_step_status = 'completed' THEN
        v_duration_ms := GREATEST(0, (extract(epoch FROM now() - COALESCE(v_step.operation_started_at, v_now)) * 1000)::INT);
        UPDATE workflow_run_steps
        SET step_status = 'completed',
            operation_completed_at = now(),
            duration_ms = COALESCE(duration_ms, v_duration_ms),
            operation_result = v_operation_result,
            last_error = NULL,
            updated_at = now()
        WHERE id = v_step.id;
    ELSIF v_step_status = 'pending' THEN
        UPDATE workflow_run_steps
        SET step_status = 'pending',
            operation_started_at = NULL,
            operation_completed_at = NULL,
            run_at = COALESCE(v_next_run_at, now()),
            retry_attempt = v_retry_attempt,
            max_retries = COALESCE((v_response_json->>'max_retries')::INT, max_retries),
            last_error = NULL,
            operation_result = v_operation_result,
            updated_at = now()
        WHERE id = v_step.id;
    ELSIF v_step_status = 'in_progress' THEN
        UPDATE workflow_run_steps
        SET operation_result = COALESCE(v_operation_result, workflow_run_steps.operation_result),
            last_error = NULL,
            updated_at = now()
        WHERE id = v_step.id;

        IF v_handler_key = 'outbound_http' THEN
            UPDATE workflow_run_steps wrs
            SET operation_result = sub.payload
            FROM (
                SELECT jsonb_build_object(
                           'outbound_call_id', oc.id,
                           'headers', oc.headers,
                           'body', oc.body
                       ) AS payload
                FROM outbound_calls oc
                WHERE oc.workflow_run_step_id = v_step.id
                ORDER BY oc.created_at DESC
                LIMIT 1
            ) sub
            WHERE wrs.id = v_step.id;
        END IF;
    ELSE
        UPDATE workflow_run_steps
        SET step_status = 'failed',
            operation_completed_at = now(),
            last_error = COALESCE(v_response_json->>'last_error', 'handler_failure'),
            operation_result = v_operation_result,
            updated_at = now()
        WHERE id = v_step.id;
    END IF;

    IF v_step_status = 'failed' THEN
        UPDATE workflow_runs
        SET workflow_status = 'failed',
            failure_reason = COALESCE(v_response_json->>'last_error', 'handler_failure'),
            last_error = jsonb_build_object('error', COALESCE(v_response_json->>'last_error', 'handler_failure')),
            context = v_context,
            updated_at = now()
        WHERE id = p_workflow_run_id;

        RETURN jsonb_build_object(
            'workflow_run_id', p_workflow_run_id,
            'status', 'failed',
            'handler_key', v_handler_key,
            'error', COALESCE(v_response_json->>'last_error', 'handler_failure')
        );
    END IF;

    IF v_response_json->>'workflow_status' IS NOT NULL THEN
        IF v_response_json->>'workflow_status' = 'completed' THEN
            UPDATE workflow_runs
            SET workflow_status = 'completed',
                current_step_id = NULL,
                completed_at = COALESCE(completed_at, now()),
                context = v_context,
                updated_at = now()
            WHERE id = p_workflow_run_id;
        ELSE
            UPDATE workflow_runs
            SET workflow_status = v_response_json->>'workflow_status',
                context = v_context,
                updated_at = now()
            WHERE id = p_workflow_run_id;
        END IF;
    ELSE
        UPDATE workflow_runs
        SET context = v_context,
            updated_at = now()
        WHERE id = p_workflow_run_id;
    END IF;

    RETURN jsonb_build_object(
        'workflow_run_id', p_workflow_run_id,
        'step_id', v_step.id,
        'status', v_step_status,
        'handler_key', v_handler_key,
        'next_run_at', v_next_run_at
    );
EXCEPTION
    WHEN OTHERS THEN
        v_error := SQLERRM;

        IF v_step.id IS NOT NULL THEN
            UPDATE workflow_run_steps
            SET step_status = 'failed',
                last_error = v_error,
                updated_at = now()
            WHERE id = v_step.id;
        END IF;

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
    IS 'Progress workflow by invoking handler-driven steps; returns status summary.';

COMMIT;

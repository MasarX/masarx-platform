-- Migration: Workflow scheduling enhancements
-- Purpose: Honour workflow scheduling metadata (delays, quiet hours, stop conditions, retries).
-- Date: 2025-10-17

BEGIN;

-- ============================================================================
-- Schema adjustments
-- ============================================================================

ALTER TABLE workflow_run_steps
    ADD COLUMN IF NOT EXISTS run_at TIMESTAMPTZ;

ALTER TABLE workflow_run_steps
    ALTER COLUMN run_at SET DEFAULT now();

ALTER TABLE workflow_run_steps
    ADD COLUMN IF NOT EXISTS runtime_state JSONB;

ALTER TABLE workflow_run_steps
    ALTER COLUMN runtime_state SET DEFAULT '{}'::jsonb;

UPDATE workflow_run_steps
SET run_at = COALESCE(run_at, enqueued_at)
WHERE run_at IS NULL;

UPDATE workflow_run_steps
SET runtime_state = COALESCE(runtime_state, '{}'::jsonb)
WHERE runtime_state IS NULL;

ALTER TABLE workflow_run_steps
    ALTER COLUMN run_at SET NOT NULL;

ALTER TABLE workflow_run_steps
    ALTER COLUMN runtime_state SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_pending_run_at
ON workflow_run_steps(run_at)
WHERE step_status = 'pending';

-- ============================================================================
-- Helper functions for scheduling/runtime orchestration
-- ============================================================================

CREATE OR REPLACE FUNCTION workflow_now()
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
AS $$
DECLARE
    v_override TEXT;
BEGIN
    BEGIN
        v_override := current_setting('masarx.now_override', TRUE);
    EXCEPTION
        WHEN others THEN
            v_override := NULL;
    END;

    IF v_override IS NOT NULL AND trim(v_override) <> '' THEN
        RETURN v_override::timestamptz;
    END IF;

    RETURN now();
END;
$$;

CREATE OR REPLACE FUNCTION workflow_schedule_timezone(p_schedule JSONB)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN COALESCE(NULLIF(p_schedule->>'timezone', ''), 'UTC');
END;
$$;

CREATE OR REPLACE FUNCTION workflow_adjust_for_quiet_hours(
    p_candidate TIMESTAMPTZ,
    p_schedule JSONB
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
AS $$
DECLARE
    v_timezone TEXT := workflow_schedule_timezone(p_schedule);
    v_quiet JSONB := COALESCE(p_schedule->'quiet_hours', '[]'::jsonb);
    v_adjusted TIMESTAMPTZ := p_candidate;
    v_iteration INT := 0;
    v_local TIMESTAMP;
    v_local_time TIME;
    v_local_date DATE;
    v_local_dow INT;
    v_entry RECORD;
    v_days JSONB;
    v_day_match BOOLEAN;
    v_start_text TEXT;
    v_end_text TEXT;
    v_start TIME;
    v_end TIME;
    v_new_local TIMESTAMP;
    v_in_quiet BOOLEAN;
    v_day_value TEXT;
    v_day_int INT;
BEGIN
    LOOP
        v_iteration := v_iteration + 1;
        EXIT WHEN v_iteration > 14;

        v_local := v_adjusted AT TIME ZONE v_timezone;
        v_local_time := v_local::time;
        v_local_date := v_local::date;
        v_local_dow := EXTRACT(DOW FROM v_local)::INT;

        v_in_quiet := FALSE;

        FOR v_entry IN
            SELECT value
            FROM jsonb_array_elements(v_quiet)
        LOOP
            v_days := v_entry.value->'days';
            v_day_match := TRUE;

            IF v_days IS NOT NULL THEN
                v_day_match := FALSE;
                FOR v_day_value IN
                    SELECT value::text
                    FROM jsonb_array_elements_text(v_days)
                LOOP
                    BEGIN
                        v_day_int := CASE
                            WHEN v_day_value ~ '^[0-6]$' THEN v_day_value::INT
                            WHEN lower(v_day_value) IN ('sun', 'sunday') THEN 0
                            WHEN lower(v_day_value) IN ('mon', 'monday') THEN 1
                            WHEN lower(v_day_value) IN ('tue', 'tuesday') THEN 2
                            WHEN lower(v_day_value) IN ('wed', 'wednesday') THEN 3
                            WHEN lower(v_day_value) IN ('thu', 'thursday') THEN 4
                            WHEN lower(v_day_value) IN ('fri', 'friday') THEN 5
                            WHEN lower(v_day_value) IN ('sat', 'saturday') THEN 6
                            ELSE NULL
                        END;
                    EXCEPTION
                        WHEN others THEN
                            v_day_int := NULL;
                    END;

                    IF v_day_int IS NOT NULL AND v_day_int = v_local_dow THEN
                        v_day_match := TRUE;
                        EXIT;
                    END IF;
                END LOOP;
            END IF;

            IF NOT v_day_match THEN
                CONTINUE;
            END IF;

            v_start_text := v_entry.value->>'start';
            v_end_text := v_entry.value->>'end';

            IF v_start_text IS NULL OR v_end_text IS NULL THEN
                CONTINUE;
            END IF;

            BEGIN
                v_start := v_start_text::time;
                v_end := v_end_text::time;
            EXCEPTION
                WHEN others THEN
                    CONTINUE;
            END;

            IF v_start <= v_end THEN
                IF v_local_time >= v_start AND v_local_time < v_end THEN
                    v_in_quiet := TRUE;
                    v_new_local := v_local_date::timestamp + v_end;
                END IF;
            ELSE
                IF v_local_time >= v_start OR v_local_time < v_end THEN
                    v_in_quiet := TRUE;
                    IF v_local_time >= v_start THEN
                        v_new_local := (v_local_date + 1)::timestamp + v_end;
                    ELSE
                        v_new_local := v_local_date::timestamp + v_end;
                    END IF;
                END IF;
            END IF;

            IF v_in_quiet THEN
                v_adjusted := timezone(v_timezone, v_new_local);
                EXIT;
            END IF;
        END LOOP;

        EXIT WHEN NOT v_in_quiet;
    END LOOP;

    RETURN v_adjusted;
END;
$$;

CREATE OR REPLACE FUNCTION workflow_compute_run_at(
    p_reference TIMESTAMPTZ,
    p_metadata JSONB,
    p_runtime_state JSONB,
    p_attempt INTEGER,
    p_is_retry BOOLEAN
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
AS $$
DECLARE
    v_schedule JSONB := COALESCE(p_metadata->'schedule', '{}'::jsonb);
    v_timezone TEXT := workflow_schedule_timezone(v_schedule);
    v_delay_seconds INT := 0;
    v_candidate TIMESTAMPTZ := p_reference;
    v_backoff JSONB;
    v_idx INT;
    v_delay_text TEXT;
    v_max_per_day INT;
    v_state_date TEXT;
    v_state_attempts INT;
    v_reference_local TIMESTAMP;
    v_reference_date TEXT;
BEGIN
    IF NOT p_is_retry THEN
        v_delay_seconds := COALESCE(
            NULLIF(p_metadata->>'delay_seconds', '')::INT,
            NULLIF(v_schedule->>'initial_delay_seconds', '')::INT,
            0
        );
    ELSE
        v_backoff := v_schedule->'retry_backoff_seconds';

        IF v_backoff IS NOT NULL AND jsonb_typeof(v_backoff) = 'array' AND jsonb_array_length(v_backoff) > 0 THEN
            v_idx := LEAST(jsonb_array_length(v_backoff), GREATEST(1, p_attempt - 1));
            SELECT value
            INTO v_delay_text
            FROM jsonb_array_elements_text(v_backoff) WITH ORDINALITY AS arr(value, idx)
            WHERE idx = v_idx;

            BEGIN
                v_delay_seconds := COALESCE(v_delay_text::INT, 0);
            EXCEPTION
                WHEN others THEN
                    v_delay_seconds := 0;
            END;
        END IF;

        IF v_delay_seconds IS NULL OR v_delay_seconds = 0 THEN
            v_delay_seconds := COALESCE(
                NULLIF(v_schedule->>'retry_default_delay_seconds', '')::INT,
                NULLIF(v_schedule->>'repeat_delay_seconds', '')::INT,
                COALESCE(
                    NULLIF(p_metadata->>'retry_delay_seconds', '')::INT,
                    0
                )
            );
        END IF;
    END IF;

    v_candidate := p_reference + make_interval(secs => COALESCE(v_delay_seconds, 0));

    IF p_is_retry THEN
        v_max_per_day := NULLIF(v_schedule->>'max_attempts_per_day', '')::INT;
        IF v_max_per_day IS NOT NULL THEN
            v_state_date := COALESCE(p_runtime_state->>'attempt_date', NULL);
            v_state_attempts := COALESCE((p_runtime_state->>'attempts_today')::INT, 0);
            v_reference_local := p_reference AT TIME ZONE v_timezone;
            v_reference_date := to_char(v_reference_local::date, 'YYYY-MM-DD');

            IF v_state_date = v_reference_date AND v_state_attempts >= v_max_per_day THEN
                v_candidate := timezone(
                    v_timezone,
                    (v_reference_local::date + 1)::timestamp
                );
            END IF;
        END IF;
    END IF;

    RETURN workflow_adjust_for_quiet_hours(v_candidate, v_schedule);
END;
$$;

CREATE OR REPLACE FUNCTION workflow_record_attempt_state(
    p_state JSONB,
    p_metadata JSONB,
    p_attempt_time TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_schedule JSONB := COALESCE(p_metadata->'schedule', '{}'::jsonb);
    v_timezone TEXT := workflow_schedule_timezone(v_schedule);
    v_state JSONB := COALESCE(p_state, '{}'::jsonb);
    v_local TIMESTAMP := p_attempt_time AT TIME ZONE v_timezone;
    v_date TEXT := to_char(v_local::date, 'YYYY-MM-DD');
    v_prev_date TEXT := v_state->>'attempt_date';
    v_attempts_today INT := 1;
BEGIN
    IF v_prev_date = v_date THEN
        v_attempts_today := COALESCE((v_state->>'attempts_today')::INT, 0) + 1;
    END IF;

    v_state := jsonb_set(v_state, '{timezone}', to_jsonb(v_timezone), TRUE);
    v_state := jsonb_set(v_state, '{attempt_date}', to_jsonb(v_date), TRUE);
    v_state := jsonb_set(v_state, '{attempts_today}', to_jsonb(v_attempts_today), TRUE);
    v_state := jsonb_set(v_state, '{last_attempt_at}', to_jsonb(p_attempt_time), TRUE);

    RETURN v_state;
END;
$$;

CREATE OR REPLACE FUNCTION workflow_should_stop(
    p_run_context JSONB,
    p_step_metadata JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_conditions JSONB := COALESCE(p_step_metadata->'stop_when', '[]'::jsonb);
    v_entry RECORD;
    v_path TEXT;
    v_expected JSONB;
    v_scope TEXT;
    v_source JSONB;
    v_actual JSONB;
    v_reason TEXT;
BEGIN
    FOR v_entry IN
        SELECT value
        FROM jsonb_array_elements(v_conditions)
    LOOP
        v_path := v_entry.value->>'path';
        IF v_path IS NULL OR trim(v_path) = '' THEN
            CONTINUE;
        END IF;

        v_scope := COALESCE(NULLIF(v_entry.value->>'scope', ''), 'context');

        IF v_scope = 'context' THEN
            v_source := COALESCE(p_run_context, '{}'::jsonb);
        ELSE
            v_source := COALESCE(p_step_metadata, '{}'::jsonb);
        END IF;

        v_actual := safe_jsonpath_query_first(v_source, v_path);

        IF v_entry.value ? 'equals' THEN
            v_expected := v_entry.value->'equals';
            IF v_expected IS NULL THEN
                IF v_actual IS NULL THEN
                    v_reason := COALESCE(v_entry.value->>'reason', format('stop_when matched NULL at path %s', v_path));
                    RETURN jsonb_build_object(
                        'stop', TRUE,
                        'reason', v_reason,
                        'path', v_path
                    );
                END IF;
            ELSIF v_actual IS NOT NULL AND v_actual = v_expected THEN
                v_reason := COALESCE(v_entry.value->>'reason', format('stop_when matched path %s', v_path));
                RETURN jsonb_build_object(
                    'stop', TRUE,
                    'reason', v_reason,
                    'path', v_path,
                    'expected', v_expected,
                    'actual', v_actual
                );
            END IF;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('stop', FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION workflow_mark_run_stopped(
    p_workflow_run_id UUID,
    p_reason TEXT,
    p_details JSONB DEFAULT '{}'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_now TIMESTAMPTZ := workflow_now();
BEGIN
    UPDATE workflow_run_steps
    SET step_status = 'skipped',
        operation_completed_at = COALESCE(operation_completed_at, v_now),
        operation_result = jsonb_build_object(
            'status', 'skipped',
            'reason', p_reason,
            'details', p_details
        ),
        updated_at = v_now
    WHERE workflow_run_id = p_workflow_run_id
      AND step_status IN ('pending', 'in_progress');

    UPDATE workflow_runs
    SET workflow_status = 'completed',
        current_step_id = NULL,
        completed_at = COALESCE(completed_at, v_now),
        metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{stop_reason}',
            to_jsonb(COALESCE(p_reason, 'stop_condition_met')),
            TRUE
        ),
        context = jsonb_set(
            COALESCE(context, '{}'::jsonb),
            '{workflow,stop_reason}',
            to_jsonb(COALESCE(p_reason, 'stop_condition_met')),
            TRUE
        ),
        updated_at = v_now
    WHERE id = p_workflow_run_id;
END;
$$;

-- ============================================================================
-- start_workflow_run (updated to populate run_at/runtime_state)
-- ============================================================================

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
    v_now TIMESTAMPTZ := workflow_now();
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
        current_step_id,
        context,
        retry_count,
        max_retries,
        failure_reason,
        last_error,
        metadata,
        version,
        created_at,
        started_at,
        updated_at,
        completed_at
    )
    VALUES (
        v_run_id,
        v_template.id,
        v_template.version,
        'webhook',
        'pending',
        NULL,
        COALESCE(p_context, '{}'::jsonb),
        0,
        NULL,
        NULL,
        NULL,
        jsonb_build_object('template_notes', v_template.notes),
        1,
        v_now,
        NULL,
        v_now,
        NULL
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
        runtime_state,
        enqueued_at,
        run_at,
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
        '{}'::jsonb,
        v_now,
        workflow_compute_run_at(
            v_now,
            COALESCE(wts.metadata, '{}'::jsonb),
            '{}'::jsonb,
            1,
            FALSE
        ),
        v_now,
        v_now
    FROM workflow_template_steps wts
    WHERE wts.workflow_template_id = v_template.id
      AND wts.enabled = TRUE
    ORDER BY wts.sequence_order;

    UPDATE workflow_run_steps wrs
    SET run_at = (
        SELECT GREATEST(
            wrs.run_at,
            COALESCE(MAX(prev.run_at), wrs.run_at)
        )
        FROM workflow_run_steps prev
        WHERE prev.workflow_run_id = wrs.workflow_run_id
          AND prev.sequence_order < wrs.sequence_order
    )
    WHERE wrs.workflow_run_id = v_run_id
      AND wrs.operation_name = 'record_workflow_completion';

    RETURN v_run_id;
END;
$$;

COMMENT ON FUNCTION start_workflow_run(UUID, JSONB)
    IS 'Create workflow run + step records with scheduling metadata applied; returns workflow_run_id.';

-- ============================================================================
-- progress_workflow_run (scheduling-aware execution)
-- ============================================================================

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
    v_now TIMESTAMPTZ := workflow_now();
    v_payload JSONB;
    v_provider_defaults JSONB := '{}'::jsonb;
    v_mapping_scope JSONB;
    v_headers JSONB;
    v_body JSONB;
    v_outbound_id UUID;
    v_status TEXT := 'pending';
    v_result JSONB;
    v_error TEXT;
    v_state JSONB;
    v_stop JSONB;
    v_next_run_at TIMESTAMPTZ;
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
      AND run_at <= v_now
    ORDER BY run_at, sequence_order
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        SELECT MIN(run_at)
        INTO v_next_run_at
        FROM workflow_run_steps
        WHERE workflow_run_id = p_workflow_run_id
          AND step_status = 'pending';

        IF v_next_run_at IS NULL THEN
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
        ELSE
            RETURN jsonb_build_object(
                'workflow_run_id', p_workflow_run_id,
                'status', 'waiting',
                'next_run_at', v_next_run_at
            );
        END IF;
    END IF;

    v_stop := workflow_should_stop(v_run.context, v_step.metadata);
    IF (v_stop->>'stop')::BOOLEAN THEN
        PERFORM workflow_mark_run_stopped(
            p_workflow_run_id,
            v_stop->>'reason',
            v_stop
        );

        RETURN jsonb_build_object(
            'workflow_run_id', p_workflow_run_id,
            'status', 'stopped',
            'reason', v_stop->>'reason'
        );
    END IF;

    UPDATE workflow_runs
    SET workflow_status = 'in_progress',
        current_step_id = v_step.workflow_template_step_id,
        started_at = COALESCE(started_at, v_now),
        updated_at = v_now
    WHERE id = p_workflow_run_id;

    v_state := workflow_record_attempt_state(
        v_step.runtime_state,
        v_step.metadata,
        v_now
    );

    UPDATE workflow_run_steps
    SET step_status = 'in_progress',
        operation_started_at = v_now,
        runtime_state = v_state,
        updated_at = v_now
    WHERE id = v_step.id;

    IF v_step.operation_name = 'record_workflow_completion' THEN
        UPDATE workflow_run_steps
        SET step_status = 'completed',
            operation_completed_at = v_now,
            duration_ms = 0,
            operation_result = jsonb_build_object('status', 'completed'),
            updated_at = v_now
        WHERE id = v_step.id;

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
        COALESCE(NULLIF(v_step.metadata->>'priority', '')::INT, 90),
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
        updated_at = workflow_now()
    WHERE id = v_step.id;

    v_status := 'in_progress';
    v_result := jsonb_build_object(
        'workflow_run_id', p_workflow_run_id,
        'step_id', v_step.id,
        'status', v_status,
        'outbound_call_id', v_outbound_id,
        'run_at', v_step.run_at
    );

    RETURN v_result;
EXCEPTION
    WHEN OTHERS THEN
        v_error := SQLERRM;

        UPDATE workflow_run_steps
        SET step_status = 'failed',
            last_error = v_error,
            updated_at = workflow_now()
        WHERE id = v_step.id;

        UPDATE workflow_runs
        SET workflow_status = 'failed',
            failure_reason = v_error,
            last_error = jsonb_build_object('error', v_error),
            updated_at = workflow_now()
        WHERE id = p_workflow_run_id;

        RETURN jsonb_build_object(
            'workflow_run_id', p_workflow_run_id,
            'status', 'failed',
            'error', v_error
        );
END;
$$;

COMMENT ON FUNCTION progress_workflow_run(UUID, JSONB)
    IS 'Progress workflow by respecting scheduling metadata (run_at, quiet hours, stop conditions).';

-- ============================================================================
-- store_response (retry-aware outbound handling)
-- ============================================================================

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
    v_run workflow_runs%ROWTYPE;
    v_now TIMESTAMPTZ := workflow_now();
    v_success BOOLEAN;
    v_error TEXT;
    v_duration INT;
    v_next_run_at TIMESTAMPTZ;
    v_state JSONB;
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

    SELECT *
    INTO v_run
    FROM workflow_runs
    WHERE id = v_step.workflow_run_id
    FOR UPDATE;

    v_success := p_status_code BETWEEN 200 AND 299;

    IF v_step.operation_started_at IS NOT NULL THEN
        v_duration := FLOOR(EXTRACT(EPOCH FROM (v_now - v_step.operation_started_at)) * 1000)::INT;
        IF v_duration < 0 THEN
            v_duration := 0;
        END IF;
    ELSE
        v_duration := NULL;
    END IF;

    IF v_success THEN
        v_state := jsonb_set(
            COALESCE(v_step.runtime_state, '{}'::jsonb),
            '{last_success_at}',
            to_jsonb(v_now),
            TRUE
        );

        UPDATE workflow_run_steps
        SET step_status = 'completed',
            operation_completed_at = v_now,
            duration_ms = v_duration,
            operation_result = jsonb_build_object(
                'response_status_code', p_status_code,
                'response_body', p_response_body
            ),
            last_error = NULL,
            runtime_state = v_state,
            updated_at = v_now
        WHERE id = v_step_id
        RETURNING workflow_run_id INTO v_run_id;

        IF v_run_id IS NOT NULL THEN
            PERFORM progress_workflow_run(v_run_id);
        END IF;

        RETURN;
    END IF;

    v_error := format('HTTP %s response for outbound job %s', p_status_code, p_job_id);
    v_state := jsonb_set(
        COALESCE(v_step.runtime_state, '{}'::jsonb),
        '{last_failure_at}',
        to_jsonb(v_now),
        TRUE
    );
    v_state := jsonb_set(
        v_state,
        '{last_error}',
        to_jsonb(v_error),
        TRUE
    );

    IF v_step.retry_attempt < v_step.max_retries THEN
        v_next_run_at := workflow_compute_run_at(
            v_now,
            v_step.metadata,
            v_state,
            v_step.retry_attempt + 1,
            TRUE
        );

        UPDATE workflow_run_steps
        SET step_status = 'pending',
            operation_completed_at = v_now,
            duration_ms = v_duration,
            operation_result = jsonb_build_object(
                'response_status_code', p_status_code,
                'response_body', p_response_body
            ),
            last_error = v_error,
            retry_attempt = v_step.retry_attempt + 1,
            run_at = v_next_run_at,
            runtime_state = v_state,
            updated_at = v_now
        WHERE id = v_step_id;

        UPDATE workflow_runs
        SET workflow_status = 'in_progress',
            current_step_id = v_step.workflow_template_step_id,
            last_error = jsonb_build_object(
                'workflow_run_step_id', v_step_id,
                'status_code', p_status_code,
                'response', p_response_body
            ),
            updated_at = v_now
        WHERE id = v_run.id;

        RETURN;
    END IF;

    UPDATE workflow_run_steps
    SET step_status = 'failed',
        operation_completed_at = v_now,
        duration_ms = v_duration,
        operation_result = jsonb_build_object(
            'response_status_code', p_status_code,
            'response_body', p_response_body
        ),
        last_error = v_error,
        runtime_state = v_state,
        updated_at = v_now
    WHERE id = v_step_id;

    UPDATE workflow_runs
    SET workflow_status = 'failed',
        failure_reason = 'workflow_step_failed',
        last_error = jsonb_build_object(
            'workflow_run_step_id', v_step_id,
            'status_code', p_status_code,
            'response', p_response_body
        ),
        updated_at = v_now
    WHERE id = v_run.id;
END;
$$;

COMMENT ON FUNCTION store_response(UUID, JSONB, INT)
    IS 'Persist outbound response, reschedule pending steps when retry budget remains, otherwise mark workflow failed.';

-- ============================================================================
-- apply_workflow_transition (stop-aware helper)
-- ============================================================================

CREATE OR REPLACE FUNCTION apply_workflow_transition(
    p_workflow_run_id UUID,
    p_step_id UUID,
    p_transition_condition JSONB,
    p_operation_result JSONB
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_condition TEXT := COALESCE(p_transition_condition->>'type', 'sequential');
    v_run workflow_runs%ROWTYPE;
    v_next UUID;
BEGIN
    IF v_condition = 'stop' THEN
        PERFORM workflow_mark_run_stopped(
            p_workflow_run_id,
            p_transition_condition->>'reason',
            COALESCE(p_transition_condition, '{}'::jsonb)
        );
        RETURN NULL;
    END IF;

    IF v_condition = 'complete' THEN
        UPDATE workflow_runs
        SET workflow_status = 'completed',
            current_step_id = NULL,
            completed_at = COALESCE(completed_at, workflow_now()),
            updated_at = workflow_now()
        WHERE id = p_workflow_run_id;
        RETURN NULL;
    END IF;

    SELECT *
    INTO v_run
    FROM workflow_runs
    WHERE id = p_workflow_run_id;

    SELECT id
    INTO v_next
    FROM workflow_run_steps
    WHERE workflow_run_id = p_workflow_run_id
      AND step_status = 'pending'
    ORDER BY run_at, sequence_order
    LIMIT 1;

    RETURN v_next;
END;
$$;

COMMENT ON FUNCTION apply_workflow_transition(UUID, UUID, JSONB, JSONB)
    IS 'Evaluate workflow transition metadata; supports explicit stop/complete directives.';

-- ============================================================================
-- run_webhook_processor_worker (respect run_at for pending steps)
-- ============================================================================

CREATE OR REPLACE FUNCTION run_webhook_processor_worker()
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_row RECORD;
    v_result JSONB;
    v_processing_context JSONB;
    v_action_results JSONB := '[]'::jsonb;
    v_org UUID;
    v_action JSONB;
    v_additional_result JSONB;
    v_pending_run RECORD;
    v_workflow_progress_count INT := 0;
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

                v_processing_context := NULL;


                PERFORM create_ops_alert_for_webhook(
                    COALESCE(
                        v_row.organization_id,
                        resolve_organization_id_strict('webhook_inbox', v_row.webhook_id)
                    ),
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

            v_processing_context := jsonb_build_object(
                'organization_id', COALESCE(
                    v_row.organization_id,
                    resolve_organization_id_strict('webhook_inbox', v_row.webhook_id)
                ),
                'policy_settings_id', v_result->>'policy_settings_id',
                'policy_scope_type', v_result->>'policy_scope_type',
                'policy_scope_id', v_result->>'policy_scope_id',
                'policy_version', v_result->>'policy_version',
                'transformed_payload', v_result->'transformed_payload',
                'webhook', v_result->'webhook',
                'workflow_followup_workflow_id', v_result->'workflow_followup_workflow_id',
                'correlation_id', v_result->>'correlation_id'
            );

            v_action_results := execute_workflow_followup_actions(
                v_row.webhook_id,
                v_result->'workflow_followup_actions',
                v_processing_context
            );

            FOR v_action IN
                SELECT elem
                FROM jsonb_array_elements(v_action_results) elem
                WHERE elem->>'workflow_run_id' IS NOT NULL
            LOOP
                PERFORM progress_workflow_run((v_action->>'workflow_run_id')::UUID);
                v_workflow_progress_count := v_workflow_progress_count + 1;
            END LOOP;

            IF v_result->'workflow_followup_workflow_id' IS NOT NULL THEN
            IF jsonb_array_length(COALESCE(v_action_results, '[]'::jsonb)) = 0
               AND NOT EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(COALESCE(v_result->'workflow_followup_actions', '[]'::jsonb)) elem
                    WHERE elem->>'handler_key' = 'start_workflow'
               )
            THEN
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


                PERFORM create_ops_alert_for_webhook(
                    COALESCE(
                        v_row.organization_id,
                        resolve_organization_id_strict('webhook_inbox', v_row.webhook_id)
                    ),
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
                      AND wrs.run_at <= now()
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
    IS 'Process webhook inbox rows and advance workflows while respecting scheduled run_at timestamps.';

-- ============================================================================
-- Three-day reminder workflow configuration and communications policy
-- ============================================================================

WITH dialog_operation AS (
    SELECT id
    FROM operation_templates
    WHERE operation_name = 'dialog360_send_whatsapp_status_v1'
    ORDER BY updated_at DESC
    LIMIT 1
),
upsert_reminder_template AS (
    INSERT INTO workflow_templates (
        id,
        name,
        description,
        version,
        status,
        scope_type,
        scope_id,
        notes
    )
    VALUES (
        '99990000-0000-0000-0000-000000320001',
        'three_day_whatsapp_reminder_v1',
        'Three-touch customer reminder with quiet hours and stop on reply.',
        1,
        'active',
        'global',
        NULL,
        'Configurable three-day reminder cadence (day 0, +1, +2) respecting quiet hours.'
    )
    ON CONFLICT (name) DO UPDATE
        SET description = EXCLUDED.description,
            status = 'active',
            scope_type = EXCLUDED.scope_type,
            scope_id = EXCLUDED.scope_id,
            notes = EXCLUDED.notes,
            updated_at = workflow_now()
    RETURNING id
),
reminder_template AS (
    SELECT id FROM upsert_reminder_template
    UNION ALL
    SELECT id
    FROM workflow_templates
    WHERE name = 'three_day_whatsapp_reminder_v1'
    LIMIT 1
),
insert_reminder_steps AS (
    INSERT INTO workflow_template_steps (
        id,
        workflow_template_id,
        sequence_order,
        operation_name,
        operation_settings_category,
        transition_condition,
        condition_jsonlogic,
        next_operation_name,
        next_operation_priority,
        next_operation_delay_seconds,
        manual_action_required,
        metadata
    )
    VALUES
        (
            '99990000-0000-0000-0000-000000320101',
            (SELECT id FROM reminder_template),
            1,
            'enqueue_notification',
            'operation_template',
            'success',
            NULL,
            NULL,
            NULL,
            NULL,
            FALSE,
            jsonb_build_object(
                'operation_template_id', (SELECT id FROM dialog_operation),
                'operation_name', 'dialog360_send_whatsapp_status_v1',
                'payload_path', '$.transformed_payload',
                'notification_template', 'three_day_reminder_day0',
                'priority', 70,
                'max_retries', 3,
                'schedule', jsonb_build_object(
                    'timezone', 'Asia/Riyadh',
                    'initial_delay_seconds', 0,
                    'retry_backoff_seconds', jsonb_build_array(900, 1800, 3600),
                    'retry_default_delay_seconds', 7200,
                    'max_attempts_per_day', 2,
                    'quiet_hours', jsonb_build_array(
                        jsonb_build_object(
                            'start', '20:00',
                            'end', '08:00'
                        )
                    )
                ),
                'stop_when', jsonb_build_array(
                    jsonb_build_object(
                        'path', '$.communication.reply_received',
                        'equals', to_jsonb(TRUE),
                        'reason', 'reply_received'
                    )
                )
            )
        ),
        (
            '99990000-0000-0000-0000-000000320102',
            (SELECT id FROM reminder_template),
            2,
            'enqueue_notification',
            'operation_template',
            'success',
            NULL,
            NULL,
            NULL,
            NULL,
            FALSE,
            jsonb_build_object(
                'operation_template_id', (SELECT id FROM dialog_operation),
                'operation_name', 'dialog360_send_whatsapp_status_v1',
                'payload_path', '$.transformed_payload',
                'notification_template', 'three_day_reminder_day1',
                'priority', 65,
                'max_retries', 3,
                'schedule', jsonb_build_object(
                    'timezone', 'Asia/Riyadh',
                    'initial_delay_seconds', 86400,
                    'retry_backoff_seconds', jsonb_build_array(900, 1800, 3600),
                    'retry_default_delay_seconds', 7200,
                    'max_attempts_per_day', 2,
                    'quiet_hours', jsonb_build_array(
                        jsonb_build_object(
                            'start', '20:00',
                            'end', '08:00'
                        )
                    )
                ),
                'stop_when', jsonb_build_array(
                    jsonb_build_object(
                        'path', '$.communication.reply_received',
                        'equals', to_jsonb(TRUE),
                        'reason', 'reply_received'
                    )
                )
            )
        ),
        (
            '99990000-0000-0000-0000-000000320103',
            (SELECT id FROM reminder_template),
            3,
            'enqueue_notification',
            'operation_template',
            'success',
            NULL,
            NULL,
            NULL,
            NULL,
            FALSE,
            jsonb_build_object(
                'operation_template_id', (SELECT id FROM dialog_operation),
                'operation_name', 'dialog360_send_whatsapp_status_v1',
                'payload_path', '$.transformed_payload',
                'notification_template', 'three_day_reminder_day2',
                'priority', 60,
                'max_retries', 3,
                'schedule', jsonb_build_object(
                    'timezone', 'Asia/Riyadh',
                    'initial_delay_seconds', 172800,
                    'retry_backoff_seconds', jsonb_build_array(900, 1800, 3600),
                    'retry_default_delay_seconds', 7200,
                    'max_attempts_per_day', 2,
                    'quiet_hours', jsonb_build_array(
                        jsonb_build_object(
                            'start', '20:00',
                            'end', '08:00'
                        )
                    )
                ),
                'stop_when', jsonb_build_array(
                    jsonb_build_object(
                        'path', '$.communication.reply_received',
                        'equals', to_jsonb(TRUE),
                        'reason', 'reply_received'
                    )
                )
            )
        ),
        (
            '99990000-0000-0000-0000-000000320104',
            (SELECT id FROM reminder_template),
            4,
            'record_workflow_completion',
            'workflow',
            'always',
            NULL,
            NULL,
            NULL,
            NULL,
            FALSE,
            jsonb_build_object('status', 'completed')
        )
    ON CONFLICT (id) DO UPDATE
        SET operation_name = EXCLUDED.operation_name,
            operation_settings_category = EXCLUDED.operation_settings_category,
            transition_condition = EXCLUDED.transition_condition,
            condition_jsonlogic = EXCLUDED.condition_jsonlogic,
            next_operation_name = EXCLUDED.next_operation_name,
            next_operation_priority = EXCLUDED.next_operation_priority,
            next_operation_delay_seconds = EXCLUDED.next_operation_delay_seconds,
            manual_action_required = EXCLUDED.manual_action_required,
            metadata = EXCLUDED.metadata,
            updated_at = workflow_now()
    RETURNING workflow_template_id
),
reminder_checksum AS (
    SELECT
        workflow_template_id,
        md5(
            string_agg(
                concat_ws(
                    '|',
                    sequence_order,
                    operation_name,
                    COALESCE(next_operation_name, ''),
                    COALESCE(operation_settings_category, ''),
                    COALESCE(transition_condition, ''),
                    COALESCE(metadata::text, '')
                ),
                '||' ORDER BY sequence_order
            )
        ) AS checksum
    FROM workflow_template_steps
    WHERE workflow_template_id = (SELECT id FROM reminder_template)
    GROUP BY workflow_template_id
)
UPDATE workflow_templates wt
SET steps_checksum = reminder_checksum.checksum,
    status = 'active',
    published_at = COALESCE(wt.published_at, workflow_now()),
    updated_at = workflow_now()
FROM reminder_checksum
WHERE wt.id = reminder_checksum.workflow_template_id;

-- Pre-GA rebaseline note:
-- Test-client scoped communications_policy fixture seeding was removed from this
-- migration. Integration/pgTAP fixtures are now materialized via test bootstrap
-- scripts only.

-- ============================================================================
-- Schema registry entry for workflow step metadata schedule contract
-- ============================================================================

INSERT INTO schema_registry (
    id,
    category,
    version,
    schema,
    description,
    examples,
    is_active,
    created_at
)
VALUES (
    'aaaa0000-0000-0000-0000-000000000701',
    'workflow_template_step_metadata',
    1,
    '{
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "Workflow Template Step Metadata",
        "type": "object",
        "additionalProperties": true,
        "properties": {
            "operation_template_id": {"type": "string", "format": "uuid"},
            "operation_name": {"type": "string"},
            "priority": {"type": "integer", "minimum": 0, "maximum": 100},
            "max_retries": {"type": "integer", "minimum": 0},
            "schedule": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "initial_delay_seconds": {"type": "integer", "minimum": 0},
                    "retry_backoff_seconds": {
                        "type": "array",
                        "items": {"type": "integer", "minimum": 0}
                    },
                    "retry_default_delay_seconds": {"type": "integer", "minimum": 0},
                    "repeat_delay_seconds": {"type": "integer", "minimum": 0},
                    "max_attempts_per_day": {"type": "integer", "minimum": 1},
                    "timezone": {"type": "string"},
                    "quiet_hours": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["start", "end"],
                            "additionalProperties": false,
                            "properties": {
                                "start": {"type": "string", "pattern": "^[0-2][0-9]:[0-5][0-9]$"},
                                "end": {"type": "string", "pattern": "^[0-2][0-9]:[0-5][0-9]$"},
                                "days": {
                                    "type": "array",
                                    "items": {"type": "string"}
                                }
                            }
                        }
                    }
                }
            },
            "stop_when": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["path", "equals"],
                    "properties": {
                        "path": {"type": "string"},
                        "equals": {},
                        "reason": {"type": "string"},
                        "scope": {"type": "string", "enum": ["context", "metadata"]}
                    }
                }
            }
        }
    }'::jsonb,
    'Scheduling metadata contract for workflow template steps',
    '[
        {
            "operation_template_id": "11110000-0000-0000-0000-000000000001",
            "priority": 60,
            "max_retries": 3,
            "schedule": {
                "timezone": "Asia/Riyadh",
                "initial_delay_seconds": 0,
                "retry_backoff_seconds": [600, 1800, 3600],
                "max_attempts_per_day": 2,
                "quiet_hours": [
                    {"start": "20:00", "end": "08:00"}
                ]
            },
            "stop_when": [
                {"path": "$.communication.reply_received", "equals": true, "reason": "reply_received"}
            ]
        }
    ]'::jsonb,
    TRUE,
    workflow_now()
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE,
    created_at = workflow_now();

INSERT INTO schema_registry (
    id,
    category,
    version,
    schema,
    description,
    examples,
    is_active,
    created_at
)
VALUES (
    'aaaa0000-0000-0000-0000-000000000702',
    'communications_policy',
    1,
    '{
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "Communications Policy",
        "type": "object",
        "required": ["version", "templates"],
        "additionalProperties": false,
        "properties": {
            "version": {"type": "integer", "minimum": 1},
            "default_timezone": {"type": "string"},
            "templates": {
                "type": "object",
                "additionalProperties": {
                    "type": "object",
                    "required": ["workflow_template_id"],
                    "properties": {
                        "workflow_template_id": {"type": "string", "format": "uuid"},
                        "channel": {"type": "string"},
                        "stop_flag_path": {"type": "string"}
                    }
                }
            }
        }
    }'::jsonb,
    'Communications policy contract linking named templates to workflow template IDs',
    '{
        "version": 1,
        "default_timezone": "Asia/Riyadh",
        "templates": {
            "three_day_reminder": {
                "workflow_template_id": "99990000-0000-0000-0000-000000320001",
                "channel": "whatsapp",
                "stop_flag_path": "$.communication.reply_received"
            }
        }
    }'::jsonb,
    TRUE,
    workflow_now()
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE,
    created_at = workflow_now();

COMMIT;







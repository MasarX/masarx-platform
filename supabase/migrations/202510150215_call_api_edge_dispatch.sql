-- Migration: Route outbound HTTP execution through the edge function.
-- - Replaces call_api() so it dispatches work to api-caller instead of using pg_net.
-- - Updates run_outbound_worker() to mark jobs for edge processing.
-- - Adds helper functions for the edge function to manage job lifecycle.
-- - Extends job_status lookup values with edge-specific states.

BEGIN;

CREATE OR REPLACE FUNCTION call_api(
    p_url TEXT,
    p_method TEXT DEFAULT 'POST',
    p_headers JSONB DEFAULT '{}'::jsonb,
    p_body JSONB DEFAULT '{}'::jsonb,
    p_timeout_seconds INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_api_caller_config JSONB;
    v_resolved_timeout INT;
    v_method TEXT := COALESCE(NULLIF(p_method, ''), 'POST');
BEGIN
    v_api_caller_config := resolve_settings(
        'api_caller_policy',
        'global',
        NULL
    );

    IF p_timeout_seconds IS NOT NULL THEN
        v_resolved_timeout := p_timeout_seconds;
    ELSIF v_api_caller_config ? 'default_timeout_seconds' THEN
        v_resolved_timeout := (v_api_caller_config->>'default_timeout_seconds')::INT;
    ELSE
        v_resolved_timeout := 30;
    END IF;

    IF v_resolved_timeout <= 0 THEN
        RAISE EXCEPTION 'Resolved timeout must be positive (resolved=%)', v_resolved_timeout;
    END IF;

    RETURN jsonb_build_object(
        'status', 202,
        'completed', FALSE,
        'edge_dispatch', jsonb_build_object(
            'url', p_url,
            'method', UPPER(v_method),
            'headers', COALESCE(p_headers, '{}'::jsonb),
            'body', COALESCE(p_body, '{}'::jsonb),
            'timeout_seconds', v_resolved_timeout
        ),
        'latency_ms', 0
    );
END;
$$;

CREATE OR REPLACE FUNCTION run_outbound_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_job RECORD;
    v_org UUID;
    v_spec JSONB;
    v_result JSONB;
    v_status INT;
    v_completed BOOLEAN;
BEGIN
    SELECT * INTO v_throttle FROM check_throttle('outbound_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := create_request_context('outbound_worker');

    FOR v_job IN SELECT * FROM claim_pending_jobs(v_throttle.batch_size)
    LOOP
        BEGIN
            IF v_job.target_type = 'provider' THEN
                v_org := resolve_organization_id_strict('provider', v_job.target_id);
            ELSIF v_job.target_type = 'client' THEN
                v_org := resolve_organization_id_strict('client', v_job.target_id);
            ELSIF v_job.shipment_id IS NOT NULL THEN
                v_org := resolve_organization_id_strict('shipment', v_job.shipment_id);
            ELSE
                v_org := resolve_organization_id_strict('outbound_call', v_job.job_id);
            END IF;

            v_spec := get_job_call_spec(v_job.job_id);
            v_result := call_api(
                v_spec->>'url',
                COALESCE(v_spec->>'method', 'POST'),
                COALESCE(v_spec->'headers', '{}'::jsonb),
                COALESCE(v_spec->'body', '{}'::jsonb),
                NULL
            );

            v_status := COALESCE((v_result->>'status')::INT, 0);
            v_completed := COALESCE((v_result->>'completed')::BOOLEAN, FALSE);

            IF v_result ? 'edge_dispatch' THEN
                UPDATE outbound_calls
                SET status = 'pending_edge',
                    lease_expires_at = NULL,
                    context = jsonb_set(
                        COALESCE(outbound_calls.context, '{}'::jsonb),
                        '{edge_dispatch}',
                        v_result->'edge_dispatch',
                        TRUE
                    ),
                    scheduled_at = now()
                WHERE id = v_job.job_id;

                PERFORM log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'http_execution',
                    p_decision_outcome := 'async_pending',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := v_result->'edge_dispatch',
                    p_decision_reason := 'Edge dispatch required for outbound HTTP execution.'
                );
            ELSIF v_completed AND v_status BETWEEN 200 AND 299 THEN
                UPDATE outbound_calls
                SET status = 'completed',
                    response_status_code = v_status,
                    response_body = v_result->'body',
                    response_headers = v_result->'headers',
                    latency_ms = (v_result->>'latency_ms')::INT,
                    completed_at = now(),
                    error_message = NULL
                WHERE id = v_job.job_id;

                PERFORM orchestrate_api_response_processing(v_job.job_id);

                PERFORM log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'http_execution',
                    p_decision_outcome := 'success',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := jsonb_build_object('status', v_status),
                    p_decision_reason := 'Outbound HTTP request completed successfully.'
                );
            ELSIF v_completed THEN
                UPDATE outbound_calls
                SET status = CASE WHEN v_job.retry_count + 1 >= v_job.max_retries THEN 'permanently_failed' ELSE 'failed' END,
                    retry_count = v_job.retry_count + 1,
                    response_status_code = v_status,
                    response_body = v_result->'body',
                    response_headers = v_result->'headers',
                    error_message = COALESCE(v_result->'body'->>'error', format('HTTP %s failure', v_status)),
                    completed_at = CASE WHEN v_job.retry_count + 1 >= v_job.max_retries THEN now() ELSE NULL END
                WHERE id = v_job.job_id;

                PERFORM log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'http_execution',
                    p_decision_outcome := 'error',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := jsonb_build_object('status', v_status),
                    p_decision_reason := format('Outbound HTTP request failed with status %s', v_status)
                );
            ELSE
                UPDATE outbound_calls
                SET status = 'pending',
                    scheduled_at = now() + interval '30 seconds',
                    context = CASE
                        WHEN v_result ? 'request_id' THEN
                            jsonb_set(
                                COALESCE(outbound_calls.context, '{}'::jsonb),
                                '{async_request_id}',
                                to_jsonb(v_result->>'request_id'),
                                TRUE
                            )
                        ELSE outbound_calls.context
                    END
                WHERE id = v_job.job_id;

                PERFORM log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'http_execution',
                    p_decision_outcome := 'async_pending',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := v_result,
                    p_decision_reason := 'HTTP request accepted asynchronously; awaiting polling.'
                );
            END IF;

            v_items_processed := v_items_processed + 1;
        EXCEPTION
            WHEN OTHERS THEN
                v_error := TRUE;
                UPDATE outbound_calls
                SET status = CASE WHEN v_job.retry_count + 1 >= v_job.max_retries THEN 'permanently_failed' ELSE 'failed' END,
                    retry_count = v_job.retry_count + 1,
                    error_message = SQLERRM,
                    completed_at = CASE WHEN v_job.retry_count + 1 >= v_job.max_retries THEN now() ELSE NULL END
                WHERE id = v_job.job_id;

                IF v_org IS NOT NULL THEN
                    PERFORM log_decision(
                        p_organization_id := v_org,
                        p_decision_category := 'outbound_call',
                        p_resource_type := 'outbound_call',
                        p_resource_id := v_job.job_id,
                        p_decision_point := 'http_execution',
                        p_decision_outcome := 'exception',
                        p_performed_by_system := 'outbound_worker',
                        p_correlation_id := v_job.correlation_id,
                        p_decision_reason := SQLERRM
                    );
                END IF;
        END;
    END LOOP;

    PERFORM complete_request_context(v_context, v_error, v_items_processed);
    PERFORM update_cron_config('outbound_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'error_occurred', v_error
    );
END;
$$;

CREATE OR REPLACE FUNCTION mark_outbound_call_in_progress(p_job_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE outbound_calls
    SET status = 'in_progress_edge',
        lease_expires_at = now() + interval '5 minutes'
    WHERE id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Outbound call % not found', p_job_id;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION mark_outbound_call_success(
    p_job_id UUID,
    p_status_code INT,
    p_headers JSONB,
    p_body JSONB,
    p_latency_ms INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_org UUID;
BEGIN
    UPDATE outbound_calls
    SET status = 'completed',
        response_status_code = p_status_code,
        response_headers = COALESCE(p_headers, '{}'::jsonb),
        response_body = COALESCE(p_body, '{}'::jsonb),
        latency_ms = p_latency_ms,
        completed_at = now(),
        error_message = NULL,
        lease_expires_at = NULL,
        context = CASE
            WHEN context ? 'edge_dispatch' THEN context - 'edge_dispatch'
            ELSE context
        END
    WHERE id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Outbound call % not found', p_job_id;
    END IF;

    PERFORM orchestrate_api_response_processing(p_job_id);

    v_org := resolve_organization_id_strict('outbound_call', p_job_id);

    PERFORM log_decision(
        p_organization_id := v_org,
        p_decision_category := 'outbound_call',
        p_resource_type := 'outbound_call',
        p_resource_id := p_job_id,
        p_decision_point := 'http_execution',
        p_decision_outcome := 'success',
        p_performed_by_system := 'api_caller_edge',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object('status', p_status_code),
        p_decision_reason := 'Outbound HTTP request completed via edge function.'
    );
END;
$$;

CREATE OR REPLACE FUNCTION mark_outbound_call_failure(
    p_job_id UUID,
    p_status_code INT,
    p_headers JSONB,
    p_body JSONB,
    p_error TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_job outbound_calls%ROWTYPE;
    v_new_status TEXT;
    v_org UUID;
    v_next_retry_count INT;
BEGIN
    SELECT *
    INTO v_job
    FROM outbound_calls
    WHERE id = p_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Outbound call % not found', p_job_id;
    END IF;

    v_next_retry_count := v_job.retry_count + 1;
    IF v_next_retry_count >= v_job.max_retries THEN
        v_new_status := 'permanently_failed';
    ELSE
        v_new_status := 'failed';
    END IF;

    UPDATE outbound_calls
    SET status = v_new_status,
        retry_count = v_next_retry_count,
        response_status_code = p_status_code,
        response_headers = COALESCE(p_headers, '{}'::jsonb),
        response_body = COALESCE(p_body, '{}'::jsonb),
        error_message = p_error,
        completed_at = CASE WHEN v_new_status = 'permanently_failed' THEN now() ELSE NULL END,
        lease_expires_at = NULL,
        context = CASE
            WHEN context ? 'edge_dispatch' THEN context - 'edge_dispatch'
            ELSE context
        END
    WHERE id = p_job_id;

    v_org := resolve_organization_id_strict('outbound_call', p_job_id);

    PERFORM log_decision(
        p_organization_id := v_org,
        p_decision_category := 'outbound_call',
        p_resource_type := 'outbound_call',
        p_resource_id := p_job_id,
        p_decision_point := 'http_execution',
        p_decision_outcome := 'error',
        p_performed_by_system := 'api_caller_edge',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object('status', p_status_code),
        p_decision_reason := COALESCE(p_error, 'Edge function reported failure')
    );
END;
$$;

INSERT INTO lookup_values (
    lookup_definition_id,
    value,
    label,
    description,
    sort_order,
    is_default
)
SELECT
    ld.id,
    v.value,
    v.label,
    v.description,
    v.sort_order,
    FALSE
FROM lookup_definitions ld
CROSS JOIN (
    VALUES
        ('pending_edge', 'Pending Edge Dispatch', 'Queued for edge function execution', 25),
        ('in_progress_edge', 'Edge In Progress', 'Edge function currently processing HTTP call', 35)
) AS v(value, label, description, sort_order)
WHERE ld.category = 'job_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

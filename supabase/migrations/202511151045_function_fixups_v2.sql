-- Migration: Function fixups v2 for lint compliance
-- Date: 2025-11-15

BEGIN;

-- Refresh call_api to ensure global scope passes NULL::uuid.
CREATE OR REPLACE FUNCTION public.call_api(
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
    v_start_time          TIMESTAMPTZ := clock_timestamp();
    v_api_caller_config   JSONB;
    v_resolved_timeout    INT;
    v_pg_net_available    BOOLEAN;
    v_request_id          BIGINT;
    v_response_status     INT;
    v_response_headers    JSONB;
    v_response_body       TEXT;
    v_wait_iterations     INT := 0;
    v_max_iterations      INT := 10; -- 10 * 100ms = 1s total poll window
BEGIN
    v_api_caller_config := resolve_settings('api_caller_policy', 'global', NULL);

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

    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') INTO v_pg_net_available;
    IF NOT v_pg_net_available THEN
        RAISE EXCEPTION 'pg_net extension not available. Enable pg_net or configure api-caller edge function to handle HTTP execution.';
    END IF;

    CASE UPPER(p_method)
        WHEN 'GET' THEN
            SELECT net.http_get(
                url := p_url,
                params := '{}'::jsonb,
                headers := p_headers,
                timeout_milliseconds := v_resolved_timeout * 1000
            ) INTO v_request_id;

        WHEN 'POST' THEN
            SELECT net.http_post(
                url := p_url,
                body := COALESCE(p_body, '{}'::jsonb),
                params := '{}'::jsonb,
                headers := p_headers,
                timeout_milliseconds := v_resolved_timeout * 1000
            ) INTO v_request_id;

        WHEN 'DELETE' THEN
            SELECT net.http_delete(
                url := p_url,
                params := '{}'::jsonb,
                headers := p_headers,
                timeout_milliseconds := v_resolved_timeout * 1000,
                body := COALESCE(p_body, '{}'::jsonb)
            ) INTO v_request_id;

        WHEN 'PUT' THEN
            SELECT net.http_post(
                url := p_url,
                body := COALESCE(p_body, '{}'::jsonb),
                params := '{}'::jsonb,
                headers := jsonb_set(p_headers, '{X-HTTP-Method-Override}', '"PUT"'),
                timeout_milliseconds := v_resolved_timeout * 1000
            ) INTO v_request_id;

        WHEN 'PATCH' THEN
            SELECT net.http_post(
                url := p_url,
                body := COALESCE(p_body, '{}'::jsonb),
                params := '{}'::jsonb,
                headers := jsonb_set(p_headers, '{X-HTTP-Method-Override}', '"PATCH"'),
                timeout_milliseconds := v_resolved_timeout * 1000
            ) INTO v_request_id;

        ELSE
            RAISE EXCEPTION 'Unsupported HTTP method: %. Supported methods: GET, POST, PUT, PATCH, DELETE', p_method;
    END CASE;

    WHILE v_wait_iterations < v_max_iterations LOOP
        BEGIN
            SELECT status_code, headers, content::TEXT
            INTO v_response_status, v_response_headers, v_response_body
            FROM net._http_response
            WHERE id = v_request_id;

            IF v_response_status IS NOT NULL THEN
                RETURN jsonb_build_object(
                    'status', v_response_status,
                    'headers', COALESCE(v_response_headers, '{}'::jsonb),
                    'body', CASE
                        WHEN v_response_body IS NULL THEN '{}'::jsonb
                        WHEN v_response_body ~ '^\s*[\[\{]' THEN v_response_body::JSONB
                        ELSE to_jsonb(v_response_body)
                    END,
                    'completed', TRUE,
                    'request_id', v_request_id,
                    'latency_ms', ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000)::INT,
                    'poll_iterations', v_wait_iterations + 1
                );
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                NULL;
        END;

        PERFORM pg_sleep(0.1);
        v_wait_iterations := v_wait_iterations + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'status', 202,
        'headers', '{}'::jsonb,
        'body', jsonb_build_object(
            'message', 'HTTP request accepted - response pending',
            'request_id', v_request_id,
            'poll_sql', format('SELECT * FROM check_async_response(%s);', v_request_id),
            'note', 'Call check_async_response(request_id) or query net._http_response for completion'
        ),
        'completed', FALSE,
        'request_id', v_request_id,
        'latency_ms', ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000)::INT,
        'poll_iterations', v_wait_iterations
    );
END;
$$;

-- Qualify identifiers inside apply_partition_index_templates to avoid ambiguity.
CREATE OR REPLACE FUNCTION public.apply_partition_index_templates()
RETURNS TABLE (
    table_name TEXT,
    partition_name TEXT,
    created_count INTEGER
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_tbl RECORD;
    v_part RECORD;
    v_created INTEGER;
    v_res RECORD;
BEGIN
    FOR v_tbl IN
        SELECT pc.table_name
        FROM partitioning_config pc
        WHERE pc.partition_strategy IN ('RANGE','HASH+RANGE')
        ORDER BY pc.table_name
    LOOP
        FOR v_part IN
            SELECT c.relname AS part_name
            FROM pg_class c
            JOIN pg_inherits i ON i.inhrelid = c.oid
            JOIN pg_class p ON p.oid = i.inhparent
            WHERE p.relname = v_tbl.table_name || '_p0'
              AND c.relkind = 'r'
            ORDER BY c.relname
        LOOP
            v_created := 0;
            FOR v_res IN SELECT * FROM public.ensure_range_partition_indexes(v_tbl.table_name, v_part.part_name)
            LOOP
                IF v_res.created THEN
                    v_created := v_created + 1;
                END IF;
            END LOOP;

            table_name := v_tbl.table_name;
            partition_name := v_part.part_name;
            created_count := v_created;
            RETURN NEXT;
        END LOOP;
    END LOOP;

    RETURN;
END;
$$;

-- Schema-qualify cron helper queries.
CREATE OR REPLACE FUNCTION public.requeue_stuck_geocoding_steps(
    p_limit INT DEFAULT 500,
    p_timeout_seconds INT DEFAULT 300
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_timeout INTERVAL := make_interval(secs => p_timeout_seconds);
    v_updated INT := 0;
BEGIN
    WITH candidates AS (
        SELECT wrs.id
        FROM public.workflow_run_steps wrs
        JOIN public.workflow_runs wr ON wr.id = wrs.workflow_run_id
        JOIN public.workflow_templates wt ON wt.id = wr.workflow_template_id
        WHERE wt.name LIKE 'workflow_geocoding%'
          AND wrs.operation_name IN ('dispatch_provider', 'fallback_provider')
          AND wrs.step_status = 'in_progress'
          AND wrs.operation_started_at IS NOT NULL
          AND wrs.operation_started_at <= now() - v_timeout
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    ),
    updated AS (
        UPDATE public.workflow_run_steps wrs
        SET step_status = 'pending',
            operation_started_at = NULL,
            operation_completed_at = NULL,
            run_at = now(),
            retry_attempt = LEAST(wrs.retry_attempt + 1, wrs.max_retries),
            last_error = 'reclaimed_by_geocoding_cron',
            updated_at = now()
        FROM candidates c
        WHERE wrs.id = c.id
        RETURNING wrs.workflow_run_id
    )
    UPDATE public.workflow_runs wr
    SET workflow_status = 'in_progress',
        updated_at = now()
    WHERE wr.id IN (SELECT workflow_run_id FROM updated);

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated;
END;
$$;

DROP FUNCTION IF EXISTS public.requeue_expired_edge_jobs(INT);
CREATE OR REPLACE FUNCTION public.requeue_expired_edge_jobs(p_limit INT DEFAULT 100)
RETURNS TABLE(job_id UUID, previous_status TEXT, lease_expires_at TIMESTAMPTZ, retry_count INT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_record RECORD;
    v_org_id UUID;
BEGIN
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN;
    END IF;

    FOR v_record IN
        SELECT oc.*
        FROM public.outbound_calls oc
        WHERE oc.status = 'in_progress_edge'
          AND oc.lease_expires_at IS NOT NULL
          AND oc.lease_expires_at < now()
        ORDER BY oc.lease_expires_at
        LIMIT GREATEST(COALESCE(p_limit, 100), 1)
        FOR UPDATE SKIP LOCKED
    LOOP
        v_org_id := public.resolve_organization_id_strict('outbound_call', v_record.id);

        UPDATE public.outbound_calls
        SET status = 'pending_edge',
            lease_expires_at = NULL,
            scheduled_at = now()
        WHERE id = v_record.id;

        PERFORM public.log_decision(
            p_organization_id := v_org_id,
            p_decision_category := 'edge_dispatch',
            p_resource_type := 'outbound_call',
            p_resource_id := v_record.id,
            p_decision_point := 'requeue_expired_edge_jobs',
            p_decision_outcome := 'requeued',
            p_performed_by_system := 'requeue_expired_edge_jobs',
            p_correlation_id := NULL,
            p_decision_inputs := jsonb_build_object(
                'previous_status', v_record.status,
                'retry_count', v_record.retry_count,
                'max_retries', v_record.max_retries,
                'lease_expires_at', v_record.lease_expires_at
            ),
            p_decision_reason := 'Edge lease expired; job returned to pending_edge queue.'
        );

        job_id := v_record.id;
        previous_status := v_record.status;
        lease_expires_at := v_record.lease_expires_at;
        retry_count := v_record.retry_count;
        RETURN NEXT;
    END LOOP;

    RETURN;
END;
$$;

DROP FUNCTION IF EXISTS public.reclaim_stale_label_jobs(INT, INT);
CREATE OR REPLACE FUNCTION public.reclaim_stale_label_jobs(
    p_limit INTEGER DEFAULT 500,
    p_timeout_seconds INTEGER DEFAULT 600
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_processed INTEGER := 0;
BEGIN
    IF to_regclass('public.label_jobs') IS NULL THEN
        RETURN 0;
    END IF;

    WITH stale AS (
        SELECT id
        FROM public.label_jobs
        WHERE status = 'in_progress'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= now() - make_interval(secs => GREATEST(COALESCE(p_timeout_seconds, 600), 60))
        ORDER BY lease_expires_at
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    ),
    updated AS (
        UPDATE public.label_jobs lj
        SET status = 'pending',
            lease_expires_at = NULL,
            scheduled_at = now(),
            error_reason = COALESCE(lj.error_reason, 'lease_expired'),
            renderer_metadata = COALESCE(lj.renderer_metadata, '{}'::jsonb) || jsonb_build_object(
                'reclaimed_at', now(),
                'reclaim_reason', 'lease_expired'
            )
        FROM stale
        WHERE lj.id = stale.id
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_processed FROM updated;

    RETURN COALESCE(v_processed, 0);
END;
$$;

DROP FUNCTION IF EXISTS public.mark_outbound_call_success(UUID, INT, JSONB, JSONB, INT);
CREATE OR REPLACE FUNCTION public.mark_outbound_call_success(
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
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN;
    END IF;

    UPDATE public.outbound_calls
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

    PERFORM public.orchestrate_api_response_processing(p_job_id);

    v_org := public.resolve_organization_id_strict('outbound_call', p_job_id);

    PERFORM public.log_decision(
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

DROP FUNCTION IF EXISTS public.mark_outbound_call_failure(UUID, INT, JSONB, JSONB, TEXT);
CREATE OR REPLACE FUNCTION public.mark_outbound_call_failure(
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
    v_job public.outbound_calls%ROWTYPE;
    v_new_status TEXT;
    v_org UUID;
    v_next_retry_count INT;
BEGIN
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN;
    END IF;

    SELECT *
    INTO v_job
    FROM public.outbound_calls
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

    UPDATE public.outbound_calls
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

    v_org := public.resolve_organization_id_strict('outbound_call', p_job_id);

    PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'outbound_call',
        p_resource_type := 'outbound_call',
        p_resource_id := p_job_id,
        p_decision_point := 'http_execution',
        p_decision_outcome := v_new_status,
        p_performed_by_system := 'api_caller_edge',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object('status', p_status_code, 'error', p_error),
        p_decision_reason := 'Outbound HTTP request failed via edge function.'
    );
END;
$$;

DROP FUNCTION IF EXISTS public.workflow_mark_run_stopped(UUID, TEXT, JSONB);
CREATE OR REPLACE FUNCTION public.workflow_mark_run_stopped(
    p_workflow_run_id UUID,
    p_reason TEXT,
    p_details JSONB DEFAULT '{}'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_now TIMESTAMPTZ := public.workflow_now();
BEGIN
    IF to_regclass('public.workflow_run_steps') IS NULL THEN
        RETURN;
    END IF;

    UPDATE public.workflow_run_steps
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

    UPDATE public.workflow_runs
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

COMMIT;

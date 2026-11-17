-- Plan: PLAN-202512-comms-reply-low-latency / Step: S04
-- Migration: Outbound inline dispatch (single-job)
-- Purpose:
--   - Provide a policy-driven inline dispatch path for latency-sensitive replies.
--   - Never persist secrets (auth injected only via get_job_call_spec at dispatch time).
--   - Fall back to queued worker processing when dispatch cannot complete within budget.
-- Date: 2025-12-16

BEGIN;

CREATE OR REPLACE FUNCTION public.dispatch_outbound_call_inline(
    p_job_id UUID,
    p_options JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_job public.outbound_calls%ROWTYPE;
    v_org UUID;
    v_optout JSONB;
    v_spec JSONB;
    v_result JSONB := NULL;
    v_status INT := 0;
    v_completed BOOLEAN := FALSE;
    v_request_id BIGINT := NULL;
    v_poll JSONB := NULL;
    v_started_at TIMESTAMPTZ := clock_timestamp();
    v_deadline TIMESTAMPTZ := NULL;
    v_latency_ms INT := NULL;

    -- Options (strict; no behavioral defaults in code)
    v_timeout_seconds INT := NULL;
    v_poll_max_seconds INT := NULL;
    v_poll_interval_ms INT := NULL;
    v_pending_reschedule_seconds INT := NULL;
    v_lease_seconds INT := NULL;
    v_performed_by_system TEXT := NULL;
    v_correlation_id UUID := NULL;
    v_sleep_seconds DOUBLE PRECISION := NULL;

    v_error TEXT := NULL;
BEGIN
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN jsonb_build_object('status', 'skipped', 'reason', 'outbound_calls_missing');
    END IF;

    IF p_job_id IS NULL THEN
        RETURN jsonb_build_object('status', 'error', 'reason', 'job_id_missing');
    END IF;

    -- Parse options. Thresholds/timeouts are policy-driven; caller must provide.
    v_timeout_seconds := NULLIF(p_options->>'timeout_seconds', '')::INT;
    v_poll_max_seconds := NULLIF(p_options->>'poll_max_seconds', '')::INT;
    v_poll_interval_ms := NULLIF(p_options->>'poll_interval_ms', '')::INT;
    v_pending_reschedule_seconds := NULLIF(p_options->>'pending_reschedule_seconds', '')::INT;
    v_lease_seconds := NULLIF(p_options->>'lease_seconds', '')::INT;

    v_performed_by_system := NULLIF(p_options->>'performed_by_system', '');
    IF v_performed_by_system IS NULL THEN
        v_performed_by_system := 'dispatch_outbound_call_inline';
    END IF;

    BEGIN
        v_correlation_id := NULLIF(p_options->>'correlation_id', '')::UUID;
    EXCEPTION
        WHEN others THEN
            v_correlation_id := NULL;
    END;

    IF v_timeout_seconds IS NULL OR v_timeout_seconds <= 0 THEN
        RAISE EXCEPTION 'inline_dispatch_timeout_missing_or_invalid';
    END IF;
    IF v_poll_max_seconds IS NULL OR v_poll_max_seconds < 0 THEN
        RAISE EXCEPTION 'inline_dispatch_poll_max_missing_or_invalid';
    END IF;
    IF v_poll_interval_ms IS NULL OR v_poll_interval_ms <= 0 THEN
        RAISE EXCEPTION 'inline_dispatch_poll_interval_missing_or_invalid';
    END IF;
    IF v_pending_reschedule_seconds IS NULL OR v_pending_reschedule_seconds <= 0 THEN
        RAISE EXCEPTION 'inline_dispatch_reschedule_missing_or_invalid';
    END IF;
    IF v_lease_seconds IS NULL OR v_lease_seconds <= 0 THEN
        RAISE EXCEPTION 'inline_dispatch_lease_missing_or_invalid';
    END IF;

    v_sleep_seconds := GREATEST(v_poll_interval_ms, 10)::DOUBLE PRECISION / 1000.0;

    SELECT *
      INTO v_job
      FROM public.outbound_calls
     WHERE id = p_job_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'error', 'reason', 'job_not_found', 'job_id', p_job_id);
    END IF;

    -- Only dispatch queued jobs; completed/skipped etc are no-ops.
    IF v_job.status NOT IN ('pending', 'failed') THEN
        RETURN jsonb_build_object(
            'status', 'skipped',
            'reason', 'job_not_dispatchable',
            'job_id', p_job_id,
            'job_status', v_job.status
        );
    END IF;

    -- Respect due time (no early sends).
    IF v_job.scheduled_at IS NOT NULL AND v_job.scheduled_at > now() THEN
        RETURN jsonb_build_object(
            'status', 'skipped',
            'reason', 'job_not_due',
            'job_id', p_job_id,
            'scheduled_at', v_job.scheduled_at
        );
    END IF;

    -- Acquire a short lease so cron workers don't concurrently dispatch this job.
    UPDATE public.outbound_calls
       SET lease_expires_at = now() + make_interval(secs => v_lease_seconds)
     WHERE id = p_job_id;

    v_org := public.resolve_organization_id_strict('outbound_call', p_job_id);

    v_optout := public.should_skip_outbound_call_for_opt_out(
        v_job.call_type,
        v_job.shipment_id,
        COALESCE(v_job.context, '{}'::jsonb)
    );

    IF COALESCE((v_optout->>'skip')::BOOLEAN, FALSE) THEN
        UPDATE public.outbound_calls
           SET status = 'skipped',
               error_message = COALESCE(v_optout->>'reason', 'skipped'),
               completed_at = now(),
               lease_expires_at = NULL
         WHERE id = p_job_id;

        PERFORM public.log_decision(
            p_organization_id := v_org,
            p_decision_category := 'outbound_call',
            p_resource_type := 'outbound_call',
            p_resource_id := p_job_id,
            p_decision_point := 'opt_out',
            p_decision_outcome := 'skipped',
            p_performed_by_system := v_performed_by_system,
            p_correlation_id := COALESCE(v_correlation_id, v_job.correlation_id),
            p_decision_inputs := v_optout,
            p_decision_reason := v_optout->>'reason'
        );

        RETURN jsonb_build_object(
            'status', 'skipped',
            'reason', v_optout->>'reason',
            'job_id', p_job_id
        );
    END IF;

    -- If an async pg_net request_id already exists, poll it first (avoid duplicate sends).
    BEGIN
        v_request_id := NULLIF(v_job.context->>'async_request_id', '')::BIGINT;
    EXCEPTION
        WHEN others THEN
            v_request_id := NULL;
    END;

    IF v_request_id IS NOT NULL THEN
        v_poll := public.check_async_response(v_request_id);
        v_completed := COALESCE((v_poll->>'completed')::BOOLEAN, FALSE);
        v_status := COALESCE((v_poll->>'status')::INT, 0);

        IF v_completed THEN
            v_result := jsonb_build_object(
                'status', v_status,
                'headers', COALESCE(v_poll->'headers', '{}'::jsonb),
                'body', COALESCE(v_poll->'body', '{}'::jsonb),
                'completed', TRUE,
                'request_id', v_request_id
            );
        END IF;
    END IF;

    IF NOT v_completed THEN
        -- Dispatch a new HTTP request and optionally wait within the policy budget.
        v_spec := public.get_job_call_spec(p_job_id);
        v_result := public.call_api(
            v_spec->>'url',
            COALESCE(v_spec->>'method', 'POST'),
            COALESCE(v_spec->'headers', '{}'::jsonb),
            COALESCE(v_spec->'body', '{}'::jsonb),
            v_timeout_seconds
        );

        v_status := COALESCE((v_result->>'status')::INT, 0);
        v_completed := COALESCE((v_result->>'completed')::BOOLEAN, FALSE);

        IF NOT v_completed THEN
            BEGIN
                v_request_id := NULLIF(v_result->>'request_id', '')::BIGINT;
            EXCEPTION
                WHEN others THEN
                    v_request_id := NULL;
            END;

            IF v_request_id IS NOT NULL THEN
                UPDATE public.outbound_calls
                   SET context = jsonb_set(
                       COALESCE(context, '{}'::jsonb),
                       '{async_request_id}',
                       to_jsonb(v_request_id),
                       TRUE
                   )
                 WHERE id = p_job_id;
            END IF;
        END IF;
    END IF;

    -- Extra polling budget (beyond call_api's internal poll window) to keep reply SLA <10s.
    IF NOT v_completed AND v_request_id IS NOT NULL AND v_poll_max_seconds > 0 THEN
        v_deadline := clock_timestamp() + make_interval(secs => v_poll_max_seconds);

        WHILE clock_timestamp() < v_deadline LOOP
            v_poll := public.check_async_response(v_request_id);
            v_completed := COALESCE((v_poll->>'completed')::BOOLEAN, FALSE);
            v_status := COALESCE((v_poll->>'status')::INT, 0);

            IF v_completed THEN
                v_result := jsonb_build_object(
                    'status', v_status,
                    'headers', COALESCE(v_poll->'headers', '{}'::jsonb),
                    'body', COALESCE(v_poll->'body', '{}'::jsonb),
                    'completed', TRUE,
                    'request_id', v_request_id
                );
                EXIT;
            END IF;

            PERFORM pg_sleep(v_sleep_seconds);
        END LOOP;
    END IF;

    v_latency_ms := ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000)::INT;

    IF v_completed AND v_status BETWEEN 200 AND 299 THEN
        UPDATE public.outbound_calls
           SET status = 'completed',
               response_status_code = v_status,
               response_body = COALESCE(v_result->'body', '{}'::jsonb),
               response_headers = COALESCE(v_result->'headers', '{}'::jsonb),
               latency_ms = v_latency_ms,
               completed_at = now(),
               error_message = NULL,
               lease_expires_at = NULL,
               context = (COALESCE(context, '{}'::jsonb) - 'async_request_id')
         WHERE id = p_job_id;

        -- Response processing failures should not flip delivery state or trigger resends.
        BEGIN
            PERFORM public.orchestrate_api_response_processing(p_job_id);
        EXCEPTION
            WHEN OTHERS THEN
                UPDATE public.outbound_calls
                   SET requires_investigation = TRUE,
                       root_cause = 'response_processing_exception',
                       resolution_notes = SQLERRM
                 WHERE id = p_job_id;

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := p_job_id,
                    p_decision_point := 'response_processing',
                    p_decision_outcome := 'exception',
                    p_performed_by_system := v_performed_by_system,
                    p_correlation_id := COALESCE(v_correlation_id, v_job.correlation_id),
                    p_decision_reason := SQLERRM
                );
        END;

        PERFORM public.log_decision(
            p_organization_id := v_org,
            p_decision_category := 'outbound_call',
            p_resource_type := 'outbound_call',
            p_resource_id := p_job_id,
            p_decision_point := 'http_execution',
            p_decision_outcome := 'success',
            p_performed_by_system := v_performed_by_system,
            p_correlation_id := COALESCE(v_correlation_id, v_job.correlation_id),
            p_decision_inputs := jsonb_build_object('status', v_status, 'latency_ms', v_latency_ms),
            p_decision_reason := 'Outbound HTTP request completed inline.'
        );

        RETURN jsonb_build_object(
            'status', 'completed',
            'job_id', p_job_id,
            'http_status', v_status,
            'completed', TRUE,
            'latency_ms', v_latency_ms
        );
    END IF;

    IF v_completed THEN
        PERFORM public.mark_outbound_call_failure(
            p_job_id,
            v_status,
            COALESCE(v_result->'headers', '{}'::jsonb),
            COALESCE(v_result->'body', '{}'::jsonb),
            COALESCE(
                NULLIF(v_result->'body'->>'error', ''),
                NULLIF(v_result->'body'->>'message', ''),
                format('HTTP %s failure', v_status)
            )
        );

        UPDATE public.outbound_calls
           SET lease_expires_at = NULL
         WHERE id = p_job_id;

        RETURN jsonb_build_object(
            'status', 'failed',
            'job_id', p_job_id,
            'http_status', v_status,
            'completed', TRUE,
            'latency_ms', v_latency_ms
        );
    END IF;

    -- Still pending: release lease and reschedule for worker.
    UPDATE public.outbound_calls
       SET status = 'pending',
           scheduled_at = now() + make_interval(secs => v_pending_reschedule_seconds),
           lease_expires_at = NULL
     WHERE id = p_job_id;

    PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'outbound_call',
        p_resource_type := 'outbound_call',
        p_resource_id := p_job_id,
        p_decision_point := 'http_execution',
        p_decision_outcome := 'async_pending',
        p_performed_by_system := v_performed_by_system,
        p_correlation_id := COALESCE(v_correlation_id, v_job.correlation_id),
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'status', v_status,
            'async_request_id', v_request_id,
            'latency_ms', v_latency_ms
        )),
        p_decision_reason := 'Inline dispatch did not complete within budget; left queued for worker.'
    );

    RETURN jsonb_build_object(
        'status', 'pending',
        'job_id', p_job_id,
        'completed', FALSE,
        'async_request_id', v_request_id,
        'latency_ms', v_latency_ms
    );
EXCEPTION
    WHEN OTHERS THEN
        v_error := SQLERRM;
        BEGIN
            UPDATE public.outbound_calls
               SET lease_expires_at = NULL
             WHERE id = p_job_id;
        EXCEPTION
            WHEN OTHERS THEN
                NULL;
        END;
        RETURN jsonb_build_object('status', 'error', 'job_id', p_job_id, 'reason', v_error);
END;
$$;

COMMENT ON FUNCTION public.dispatch_outbound_call_inline(UUID, JSONB)
  IS 'Policy-driven inline dispatch for a single outbound_calls job with optional async polling budget; never persists secrets and falls back to queued worker on timeout.';

COMMIT;


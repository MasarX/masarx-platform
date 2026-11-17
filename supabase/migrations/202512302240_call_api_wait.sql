-- Migration: call_api_wait (blocking pg_net helper)
-- Purpose:
--  - Provide an opt-in blocking variant for call_api() that waits for completion
--    (up to a configurable window) by polling check_async_response(request_id).
-- Notes:
--  - Reuses existing call_api + check_async_response (no duplicated HTTP logic).
--  - Intended for sync UX paths (e.g., label rendering) where delays are unacceptable.

BEGIN;

SET search_path TO public, pg_temp;

CREATE OR REPLACE FUNCTION public.call_api_wait(
    p_url TEXT,
    p_method TEXT DEFAULT 'POST',
    p_headers JSONB DEFAULT '{}'::jsonb,
    p_body JSONB DEFAULT '{}'::jsonb,
    p_timeout_seconds INT DEFAULT NULL,
    p_wait_seconds INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_start_time TIMESTAMPTZ := clock_timestamp();
    v_api_caller_config JSONB;
    v_wait_seconds INT;
    v_deadline TIMESTAMPTZ;
    v_poll_iterations INT := 0;
    v_max_iterations INT;
    v_initial JSONB;
    v_request_id BIGINT;
    v_check JSONB;
    v_completed BOOLEAN := FALSE;
    v_status INT;
    v_headers JSONB;
    v_body JSONB;
BEGIN
    -- Compute a wait window (defaults to api_caller_policy.default_timeout_seconds).
    v_api_caller_config := resolve_settings('api_caller_policy', 'global', NULL);

    IF p_wait_seconds IS NOT NULL THEN
        v_wait_seconds := p_wait_seconds;
    ELSIF p_timeout_seconds IS NOT NULL THEN
        v_wait_seconds := p_timeout_seconds;
    ELSIF v_api_caller_config ? 'default_timeout_seconds' THEN
        v_wait_seconds := (v_api_caller_config->>'default_timeout_seconds')::INT;
    ELSE
        v_wait_seconds := 30;
    END IF;

    IF v_wait_seconds <= 0 THEN
        RAISE EXCEPTION 'call_api_wait: wait_seconds must be positive (got=%)', v_wait_seconds;
    END IF;

    v_deadline := clock_timestamp() + make_interval(secs => v_wait_seconds);
    -- Poll at 200ms intervals (bounded by the wait window).
    v_max_iterations := CEIL(v_wait_seconds / 0.2);

    v_initial := public.call_api(
        p_url,
        p_method,
        COALESCE(p_headers, '{}'::jsonb),
        COALESCE(p_body, '{}'::jsonb),
        p_timeout_seconds
    );

    IF COALESCE((v_initial->>'completed')::BOOLEAN, FALSE) THEN
        RETURN v_initial;
    END IF;

    v_request_id := NULLIF(v_initial->>'request_id', '')::BIGINT;
    IF v_request_id IS NULL THEN
        RETURN v_initial;
    END IF;

    WHILE clock_timestamp() < v_deadline AND v_poll_iterations < v_max_iterations LOOP
        v_check := public.check_async_response(v_request_id);
        v_completed := COALESCE((v_check->>'completed')::BOOLEAN, FALSE);
        IF v_completed THEN
            v_status := NULLIF(v_check->>'status', '')::INT;
            v_headers := COALESCE(v_check->'headers', '{}'::jsonb);
            v_body := COALESCE(v_check->'body', '{}'::jsonb);

            RETURN jsonb_build_object(
                'status', v_status,
                'headers', v_headers,
                'body', v_body,
                'completed', TRUE,
                'request_id', v_request_id,
                'latency_ms', ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000)::INT,
                'poll_iterations', v_poll_iterations + 1
            );
        END IF;

        PERFORM pg_sleep(0.2);
        v_poll_iterations := v_poll_iterations + 1;
    END LOOP;

    -- Timed out waiting; return the original response (still includes request_id for async follow-up).
    RETURN v_initial || jsonb_build_object(
        'wait_seconds', v_wait_seconds,
        'wait_poll_iterations', v_poll_iterations
    );
END;
$$;

COMMENT ON FUNCTION public.call_api_wait(TEXT, TEXT, JSONB, JSONB, INT, INT)
    IS 'Blocking wrapper around call_api() that waits for completion by polling check_async_response(request_id).';

GRANT EXECUTE ON FUNCTION public.call_api_wait(TEXT, TEXT, JSONB, JSONB, INT, INT) TO service_role;

COMMIT;

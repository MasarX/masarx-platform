-- Plan: PLAN-202601-demo-speed-here-failfast / Step: S04
-- Migration: Prefer edge dispatch for call_api when configured
-- Date: 2026-01-11
BEGIN;
SET search_path TO public, workflow_handlers, extensions, pg_temp;

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
AS $function$
DECLARE
    v_start_time          TIMESTAMPTZ := clock_timestamp();
    v_api_caller_config   JSONB;
    v_edge_settings       JSONB;
    v_edge_url            TEXT;
    v_edge_enabled        BOOLEAN := FALSE;
    v_resolved_timeout    INT;
    v_pg_net_available    BOOLEAN;
    v_request_id          BIGINT;
    v_response_status     INT;
    v_response_headers    JSONB;
    v_response_body       TEXT;
    v_wait_iterations     INT := 0;
    v_max_iterations      INT := 10; -- 10 * 100ms = 1s total poll window
    v_method              TEXT := COALESCE(NULLIF(p_method, ''), 'POST');
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

    BEGIN
        v_edge_settings := resolve_settings('edge_dispatch_policy', 'global', NULL);
        v_edge_url := NULLIF(COALESCE(v_edge_settings->>'endpoint_url', ''), '');
        BEGIN
            v_edge_enabled := COALESCE(NULLIF(v_edge_settings->>'enabled', '')::BOOLEAN, TRUE);
        EXCEPTION
            WHEN others THEN
                v_edge_enabled := TRUE;
        END;
    EXCEPTION
        WHEN others THEN
            v_edge_settings := NULL;
            v_edge_url := NULL;
            v_edge_enabled := FALSE;
    END;

    IF v_edge_enabled AND v_edge_url IS NOT NULL THEN
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
    END IF;

    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') INTO v_pg_net_available;
    IF NOT v_pg_net_available THEN
        RAISE EXCEPTION 'pg_net extension not available. Enable pg_net or configure api-caller edge function to handle HTTP execution.';
    END IF;

    CASE UPPER(v_method)
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
                        WHEN v_response_body ~ '^\\s*[\\[\\{]' THEN v_response_body::JSONB
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
$function$;

COMMIT;

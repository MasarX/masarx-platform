-- Migration: call_api_wait dispatch refactor
-- Purpose:
--  - Keep generic HTTP dispatch row-driven while removing the inherited 1s inline wait ceiling from call_api().
--  - Reuse a shared pg_net dispatch helper so blocking callers can wait for the full configured window.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061600_call_api_wait_dispatch_refactor_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.dispatch_api_request_v1(
    p_url TEXT,
    p_method TEXT DEFAULT 'POST',
    p_headers JSONB DEFAULT '{}'::jsonb,
    p_body JSONB DEFAULT '{}'::jsonb,
    p_timeout_seconds INT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_request_id BIGINT;
    v_timeout_seconds INT := GREATEST(COALESCE(p_timeout_seconds, 30), 1);
    v_method TEXT := UPPER(COALESCE(NULLIF(p_method, ''), 'POST'));
    v_headers JSONB := COALESCE(p_headers, '{}'::jsonb);
    v_body JSONB := COALESCE(p_body, '{}'::jsonb);
    v_pg_net_available BOOLEAN := FALSE;
BEGIN
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
      INTO v_pg_net_available;

    IF NOT v_pg_net_available THEN
        RAISE EXCEPTION 'pg_net extension not available. Enable pg_net or configure api-caller edge function to handle HTTP execution.';
    END IF;

    CASE v_method
        WHEN 'GET' THEN
            SELECT net.http_get(
                url := p_url,
                params := '{}'::jsonb,
                headers := v_headers,
                timeout_milliseconds := v_timeout_seconds * 1000
            ) INTO v_request_id;
        WHEN 'POST' THEN
            SELECT net.http_post(
                url := p_url,
                body := v_body,
                params := '{}'::jsonb,
                headers := v_headers,
                timeout_milliseconds := v_timeout_seconds * 1000
            ) INTO v_request_id;
        WHEN 'DELETE' THEN
            SELECT net.http_delete(
                url := p_url,
                params := '{}'::jsonb,
                headers := v_headers,
                timeout_milliseconds := v_timeout_seconds * 1000,
                body := v_body
            ) INTO v_request_id;
        WHEN 'PUT' THEN
            SELECT net.http_post(
                url := p_url,
                body := v_body,
                params := '{}'::jsonb,
                headers := jsonb_set(v_headers, '{X-HTTP-Method-Override}', '"PUT"'),
                timeout_milliseconds := v_timeout_seconds * 1000
            ) INTO v_request_id;
        WHEN 'PATCH' THEN
            SELECT net.http_post(
                url := p_url,
                body := v_body,
                params := '{}'::jsonb,
                headers := jsonb_set(v_headers, '{X-HTTP-Method-Override}', '"PATCH"'),
                timeout_milliseconds := v_timeout_seconds * 1000
            ) INTO v_request_id;
        ELSE
            RAISE EXCEPTION 'Unsupported HTTP method: %. Supported methods: GET, POST, PUT, PATCH, DELETE', p_method;
    END CASE;

    RETURN v_request_id;
END;
$$;

COMMENT ON FUNCTION public.dispatch_api_request_v1(TEXT, TEXT, JSONB, JSONB, INT)
  IS 'Dispatch an HTTP request through pg_net and return the request id for async polling.';

REVOKE ALL ON FUNCTION public.dispatch_api_request_v1(TEXT, TEXT, JSONB, JSONB, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_api_request_v1(TEXT, TEXT, JSONB, JSONB, INT) TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.dispatch_api_request_v1(TEXT, TEXT, JSONB, JSONB, INT) TO edge_label_renderer_role;
  END IF;
END;
$$;

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
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_start_time          TIMESTAMPTZ := clock_timestamp();
    v_api_caller_config   JSONB;
    v_edge_settings       JSONB;
    v_edge_url            TEXT;
    v_edge_enabled        BOOLEAN := FALSE;
    v_resolved_timeout    INT;
    v_request_id          BIGINT;
    v_response_status     INT;
    v_response_headers    JSONB;
    v_response_body       TEXT;
    v_wait_iterations     INT := 0;
    v_max_iterations      INT := 10;
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

    v_request_id := public.dispatch_api_request_v1(
        p_url,
        v_method,
        COALESCE(p_headers, '{}'::jsonb),
        COALESCE(p_body, '{}'::jsonb),
        v_resolved_timeout
    );

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
$$;

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
    v_edge_settings JSONB;
    v_edge_url TEXT;
    v_edge_enabled BOOLEAN := FALSE;
    v_timeout_seconds INT;
    v_wait_seconds INT;
    v_deadline TIMESTAMPTZ;
    v_poll_iterations INT := 0;
    v_max_iterations INT;
    v_request_id BIGINT;
    v_check JSONB;
    v_status INT;
    v_headers JSONB;
    v_body JSONB;
    v_method TEXT := COALESCE(NULLIF(p_method, ''), 'POST');
BEGIN
    v_api_caller_config := resolve_settings('api_caller_policy', 'global', NULL);

    IF p_timeout_seconds IS NOT NULL THEN
        v_timeout_seconds := p_timeout_seconds;
    ELSIF v_api_caller_config ? 'default_timeout_seconds' THEN
        v_timeout_seconds := (v_api_caller_config->>'default_timeout_seconds')::INT;
    ELSE
        v_timeout_seconds := 30;
    END IF;

    IF v_timeout_seconds <= 0 THEN
        RAISE EXCEPTION 'Resolved timeout must be positive (resolved=%)', v_timeout_seconds;
    END IF;

    IF p_wait_seconds IS NOT NULL THEN
        v_wait_seconds := p_wait_seconds;
    ELSE
        v_wait_seconds := v_timeout_seconds;
    END IF;

    IF v_wait_seconds <= 0 THEN
        RAISE EXCEPTION 'call_api_wait: wait_seconds must be positive (got=%)', v_wait_seconds;
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
                'timeout_seconds', v_timeout_seconds
            ),
            'latency_ms', 0,
            'wait_seconds', v_wait_seconds,
            'wait_poll_iterations', 0
        );
    END IF;

    v_deadline := clock_timestamp() + make_interval(secs => v_wait_seconds);
    v_max_iterations := CEIL(v_wait_seconds::numeric / 0.2)::INT;
    v_request_id := public.dispatch_api_request_v1(
        p_url,
        v_method,
        COALESCE(p_headers, '{}'::jsonb),
        COALESCE(p_body, '{}'::jsonb),
        v_timeout_seconds
    );

    WHILE clock_timestamp() < v_deadline AND v_poll_iterations < v_max_iterations LOOP
        v_check := public.check_async_response(v_request_id);
        IF COALESCE((v_check->>'completed')::BOOLEAN, FALSE) THEN
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
                'poll_iterations', v_poll_iterations + 1,
                'wait_seconds', v_wait_seconds,
                'wait_poll_iterations', v_poll_iterations + 1
            );
        END IF;

        PERFORM pg_sleep(0.2);
        v_poll_iterations := v_poll_iterations + 1;
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
        'poll_iterations', v_poll_iterations,
        'wait_seconds', v_wait_seconds,
        'wait_poll_iterations', v_poll_iterations
    );
END;
$$;

COMMENT ON FUNCTION public.call_api_wait(TEXT, TEXT, JSONB, JSONB, INT, INT)
  IS 'Blocking wrapper around pg_net dispatch that waits for completion by polling check_async_response(request_id).';

GRANT EXECUTE ON FUNCTION public.call_api_wait(TEXT, TEXT, JSONB, JSONB, INT, INT) TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.call_api_wait(TEXT, TEXT, JSONB, JSONB, INT, INT) TO edge_label_renderer_role;
  END IF;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202603061600_call_api_wait_dispatch_refactor_v1'));
COMMIT;

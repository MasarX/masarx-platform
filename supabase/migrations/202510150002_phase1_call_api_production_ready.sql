-- Purpose: Implement call_api() with pg_net-based execution, async polling, and helper utilities for workers.
-- Date: 2025-10-15
-- Requirements:
--   * pg_net extension must be installed (`CREATE EXTENSION IF NOT EXISTS pg_net;`).
--   * For environments without pg_net the function raises a clear exception instructing operators to enable it or route via edge functions.

-- NOTE: A complete settings resolver will be introduced in Phase 3.
--       For now we provide a minimal stub so dependent functions compile.

CREATE OR REPLACE FUNCTION resolve_settings(
    p_category TEXT,
    p_scope_type TEXT,
    p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Placeholder implementation. Subsequent migrations will replace this stub
    -- with the full override-ladder resolver. Returning NULL signals callers to
    -- fall back to their default values.
    RETURN NULL;
END;
$$;

-- =============================================================================
-- Function: call_api
-- =============================================================================
-- Behaviour:
--   1. Resolves timeout from api_caller_policy settings (fallback 30s).
--   2. Executes HTTP request via pg_net (supports GET/POST/PUT/PATCH/DELETE).
--   3. Polls up to 1 second (10 x 100ms) for synchronous completion.
--   4. Returns completed response (status/headers/body) with request_id.
--   5. If still pending after polling, returns HTTP 202 with polling instructions.
--   6. If pg_net extension not available, raises an exception (fail-fast).

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
    -- Resolve timeout from settings (Global scope)
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

    -- Ensure pg_net extension exists (fail fast otherwise)
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') INTO v_pg_net_available;
    IF NOT v_pg_net_available THEN
        RAISE EXCEPTION 'pg_net extension not available. Enable pg_net or configure api-caller edge function to handle HTTP execution.';
    END IF;

    -- Execute HTTP call via pg_net
    CASE UPPER(p_method)
        WHEN 'GET' THEN
            SELECT net.http_get(
                url := p_url,
                headers := p_headers,
                timeout_milliseconds := v_resolved_timeout * 1000
            ) INTO v_request_id;

        WHEN 'POST' THEN
            SELECT net.http_post(
                url := p_url,
                headers := p_headers,
                body := COALESCE(p_body::TEXT::BYTEA, ''::BYTEA),
                timeout_milliseconds := v_resolved_timeout * 1000
            ) INTO v_request_id;

        WHEN 'DELETE' THEN
            SELECT net.http_delete(
                url := p_url,
                headers := p_headers,
                timeout_milliseconds := v_resolved_timeout * 1000
            ) INTO v_request_id;

        WHEN 'PUT' THEN
            SELECT net.http_post( -- method override
                url := p_url,
                headers := jsonb_set(p_headers, '{X-HTTP-Method-Override}', '"PUT"'),
                body := COALESCE(p_body::TEXT::BYTEA, ''::BYTEA),
                timeout_milliseconds := v_resolved_timeout * 1000
            ) INTO v_request_id;

        WHEN 'PATCH' THEN
            SELECT net.http_post( -- method override
                url := p_url,
                headers := jsonb_set(p_headers, '{X-HTTP-Method-Override}', '"PATCH"'),
                body := COALESCE(p_body::TEXT::BYTEA, ''::BYTEA),
                timeout_milliseconds := v_resolved_timeout * 1000
            ) INTO v_request_id;

        ELSE
            RAISE EXCEPTION 'Unsupported HTTP method: %. Supported methods: GET, POST, PUT, PATCH, DELETE', p_method;
    END CASE;

    -- Poll for synchronous completion (max 1 second)
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
                -- Ignore transient errors while polling (continue loop)
                NULL;
        END;

        PERFORM pg_sleep(0.1); -- 100ms
        v_wait_iterations := v_wait_iterations + 1;
    END LOOP;

    -- Async response still pending: return 202 with polling instructions
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

COMMENT ON FUNCTION call_api(TEXT, TEXT, JSONB, JSONB, INT)
    IS 'Execute HTTP calls via pg_net with up to 1s synchronous polling. Returns completed response or 202 with request_id.';

-- =============================================================================
-- Helper: check_async_response
-- =============================================================================
-- Returns the finalised response for a given request_id (completed flag indicates whether the response exists).

CREATE OR REPLACE FUNCTION check_async_response(p_request_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_response_status  INT;
    v_response_headers JSONB;
    v_response_body    TEXT;
BEGIN
    BEGIN
        SELECT status_code, headers, content::TEXT
        INTO v_response_status, v_response_headers, v_response_body
        FROM net._http_response
        WHERE id = p_request_id;
    EXCEPTION
        WHEN undefined_table THEN
            RAISE EXCEPTION 'pg_net extension not available (net._http_response missing). Enable pg_net to use check_async_response().';
    END;

    IF v_response_status IS NULL THEN
        RETURN jsonb_build_object(
            'completed', FALSE,
            'status', NULL,
            'headers', '{}'::jsonb,
            'body', '{}'::jsonb
        );
    END IF;

    RETURN jsonb_build_object(
        'completed', TRUE,
        'status', v_response_status,
        'headers', COALESCE(v_response_headers, '{}'::jsonb),
        'body', CASE
            WHEN v_response_body IS NULL THEN '{}'::jsonb
            WHEN v_response_body ~ '^\s*[\[\{]' THEN v_response_body::JSONB
            ELSE to_jsonb(v_response_body)
        END
    );
END;
$$;

COMMENT ON FUNCTION check_async_response(BIGINT)
    IS 'Return completion status and payload for a pg_net request_id. Used by workers to resolve async (202) responses.';

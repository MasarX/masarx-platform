-- Edge dispatch helpers: logging and batch claiming for outbound calls.

BEGIN;

CREATE OR REPLACE FUNCTION log_api_call_event(
    p_job_id UUID,
    p_request JSONB,
    p_response JSONB,
    p_status INT,
    p_latency_ms INT,
    p_error TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_job outbound_calls%ROWTYPE;
    v_org UUID;
    v_provider UUID;
    v_operation TEXT;
    v_method TEXT;
    v_url TEXT;
    v_request_headers JSONB;
    v_request_body JSONB;
    v_response_headers JSONB;
    v_response_body JSONB;
BEGIN
    SELECT *
    INTO v_job
    FROM outbound_calls
    WHERE id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'log_api_call_event: job % not found', p_job_id;
    END IF;

    v_org := resolve_organization_id_strict('outbound_call', p_job_id);
    IF v_job.target_type = 'provider' THEN
        v_provider := v_job.target_id;
    ELSE
        v_provider := NULL;
    END IF;

    v_operation := v_job.call_type;

    v_method := COALESCE(p_request->>'method', v_job.method, 'POST');
    v_url := COALESCE(p_request->>'url', v_job.url, '');

    v_request_headers := COALESCE(p_request->'headers', '{}'::jsonb);
    v_request_body := COALESCE(p_request->'body', '{}'::jsonb);

    v_response_headers := COALESCE(p_response->'headers', '{}'::jsonb);
    v_response_body := COALESCE(p_response->'body', '{}'::jsonb);

    INSERT INTO api_call_log (
        organization_id,
        provider_id,
        operation,
        method,
        url,
        request_headers,
        request_body,
        response_status,
        response_headers,
        response_body,
        duration_ms,
        error_message
    )
    VALUES (
        v_org,
        v_provider,
        v_operation,
        v_method,
        v_url,
        v_request_headers,
        v_request_body,
        p_status,
        v_response_headers,
        v_response_body,
        p_latency_ms,
        p_error
    );
END;
$$;

CREATE OR REPLACE FUNCTION claim_pending_edge_jobs(p_batch INT DEFAULT 10)
RETURNS TABLE (
    job_id UUID,
    dispatch JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    WITH selected AS (
        SELECT
            oc.id,
            oc.context->'edge_dispatch' AS edge_dispatch,
            get_job_call_spec(oc.id) AS spec
        FROM outbound_calls oc
        WHERE oc.status = 'pending_edge'
          AND (oc.lease_expires_at IS NULL OR oc.lease_expires_at < now())
        ORDER BY oc.priority DESC, oc.scheduled_at
        LIMIT GREATEST(COALESCE(p_batch, 10), 1)
        FOR UPDATE SKIP LOCKED
    ),
    updated AS (
        UPDATE outbound_calls oc
        SET status = 'in_progress_edge',
            lease_expires_at = now() + interval '5 minutes'
        WHERE oc.id IN (SELECT id FROM selected)
        RETURNING oc.id
    )
    SELECT
        s.id AS job_id,
        jsonb_build_object(
            'url', COALESCE(s.edge_dispatch->>'url', s.spec->>'url'),
            'method', COALESCE(upper(s.edge_dispatch->>'method'), upper(s.spec->>'method'), 'POST'),
            'headers', COALESCE(s.edge_dispatch->'headers', s.spec->'headers', '{}'::jsonb),
            'body', COALESCE(s.edge_dispatch->'body', s.spec->'body', '{}'::jsonb),
            'timeout_seconds', COALESCE(
                NULLIF(s.edge_dispatch->>'timeout_seconds', '')::INT,
                NULLIF(s.spec->>'timeout_seconds', '')::INT,
                30
            )
        ) AS dispatch
    FROM selected s
    JOIN updated u ON u.id = s.id;
END;
$$;

COMMIT;

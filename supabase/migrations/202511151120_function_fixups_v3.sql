-- Migration: Function fixups v3 for lint compliance
-- Date: 2025-11-15

BEGIN;

-- Label renderer helper: schema-qualify settings and guard for existence.
DROP FUNCTION IF EXISTS public.invoke_label_renderer(INT);
CREATE OR REPLACE FUNCTION public.invoke_label_renderer(p_max_jobs INT DEFAULT 5)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_settings JSONB;
    v_provider JSONB;
    v_url TEXT;
    v_secret TEXT;
    v_timeout_ms INT;
    v_timeout_seconds INT;
    v_headers JSONB;
    v_payload JSONB;
    v_response JSONB;
BEGIN
    IF to_regclass('public.settings') IS NULL THEN
        RAISE EXCEPTION 'invoke_label_renderer: settings table missing';
    END IF;

    SELECT s.cached_value
    INTO v_settings
    FROM public.settings s
    WHERE s.category = 'label_provider'
      AND s.scope_type = 'global'
    ORDER BY s.last_updated DESC
    LIMIT 1;

    IF v_settings IS NULL THEN
        RAISE EXCEPTION 'invoke_label_renderer: label_provider settings not found';
    END IF;

    v_provider := COALESCE((v_settings->'providers')->0, '{}'::jsonb);

    v_url := NULLIF(v_provider->>'invoke_url', '');
    v_secret := NULLIF(v_provider->>'invoke_secret', '');
    v_timeout_ms := COALESCE((v_provider->>'timeout_ms')::INT, 15000);

    IF v_url IS NULL THEN
        RAISE EXCEPTION 'invoke_label_renderer: invoke_url missing in label_provider configuration';
    END IF;

    IF v_secret IS NULL THEN
        RAISE EXCEPTION 'invoke_label_renderer: invoke_secret missing in label_provider configuration';
    END IF;

    IF v_url LIKE 'https://example.%' OR v_secret = 'EXAMPLE_PASSWORD' THEN
        RAISE EXCEPTION 'invoke_label_renderer: provider invoke configuration not activated (update settings)';
    END IF;

    v_headers := jsonb_build_object(
        'content-type', 'application/json',
        'authorization', concat('Bearer ', v_secret)
    );

    v_payload := jsonb_build_object(
        'max_jobs', GREATEST(COALESCE(p_max_jobs, 5), 1)
    );

    v_timeout_seconds := GREATEST((v_timeout_ms + 999) / 1000, 1);

    v_response := public.call_api(
        v_url,
        'POST',
        v_headers,
        v_payload,
        v_timeout_seconds
    );

    RETURN v_response || jsonb_build_object(
        'request_payload', v_payload,
        'provider_name', v_provider->>'name'
    );
END;
$$;

-- Escalate geocoding manual review with schema-qualified tables.
DROP FUNCTION IF EXISTS public.escalate_geocoding_manual_review(INT);
CREATE OR REPLACE FUNCTION public.escalate_geocoding_manual_review(
    p_limit INT DEFAULT 200
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_updated INT;
BEGIN
    IF to_regclass('public.manual_review_tasks') IS NULL THEN
        RETURN 0;
    END IF;

    WITH due_tasks AS (
        SELECT id
        FROM public.manual_review_tasks
        WHERE task_type = 'geocoding'
          AND status = 'pending'
          AND sla_due_at IS NOT NULL
          AND sla_due_at < now()
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    ),
    escalated AS (
        UPDATE public.manual_review_tasks mrt
        SET status = 'escalated',
            queue_assignment = COALESCE(mrt.queue_assignment, 'geo_ops_on_call'),
            metadata = COALESCE(mrt.metadata, '{}'::jsonb) || jsonb_build_object('escalated_at', now()),
            updated_at = now()
        FROM due_tasks dt
        WHERE mrt.id = dt.id
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_updated FROM escalated;

    RETURN COALESCE(v_updated, 0);
END;
$$;

-- Cleanup expired geocodes gracefully.
DROP FUNCTION IF EXISTS public.cleanup_expired_geocodes(INT);
CREATE OR REPLACE FUNCTION public.cleanup_expired_geocodes(
    p_limit INT DEFAULT 1000
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_deleted INT;
BEGIN
    IF to_regclass('public.geocodes') IS NULL THEN
        RETURN 0;
    END IF;

    WITH doomed AS (
        SELECT ctid
        FROM public.geocodes
        WHERE expires_at IS NOT NULL
          AND expires_at < now()
        LIMIT p_limit
    )
    DELETE FROM public.geocodes g
    USING doomed d
    WHERE g.ctid = d.ctid;

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN COALESCE(v_deleted, 0);
END;
$$;

-- Edge dispatch logging helpers.
DROP FUNCTION IF EXISTS public.log_api_call_event(UUID, JSONB, JSONB, INT, INT, TEXT);
CREATE OR REPLACE FUNCTION public.log_api_call_event(
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
    v_job public.outbound_calls%ROWTYPE;
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
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN;
    END IF;

    SELECT *
    INTO v_job
    FROM public.outbound_calls
    WHERE id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'log_api_call_event: job % not found', p_job_id;
    END IF;

    v_org := public.resolve_organization_id_strict('outbound_call', p_job_id);
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

    INSERT INTO public.api_call_log (
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

DROP FUNCTION IF EXISTS public.claim_pending_edge_jobs(INT);
CREATE OR REPLACE FUNCTION public.claim_pending_edge_jobs(p_batch INT DEFAULT 10)
RETURNS TABLE (
    job_id UUID,
    dispatch JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH selected AS (
        SELECT
            oc.id,
            oc.context->'edge_dispatch' AS edge_dispatch,
            public.get_job_call_spec(oc.id) AS spec
        FROM public.outbound_calls oc
        WHERE oc.status = 'pending_edge'
          AND (oc.lease_expires_at IS NULL OR oc.lease_expires_at < now())
        ORDER BY oc.priority DESC, oc.scheduled_at
        LIMIT GREATEST(COALESCE(p_batch, 10), 1)
        FOR UPDATE SKIP LOCKED
    ),
    updated AS (
        UPDATE public.outbound_calls oc
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

DROP FUNCTION IF EXISTS public.mark_outbound_call_in_progress(UUID);
CREATE OR REPLACE FUNCTION public.mark_outbound_call_in_progress(p_job_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN;
    END IF;

    UPDATE public.outbound_calls
    SET status = 'in_progress_edge',
        lease_expires_at = now() + interval '5 minutes'
    WHERE id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Outbound call % not found', p_job_id;
    END IF;
END;
$$;

COMMIT;

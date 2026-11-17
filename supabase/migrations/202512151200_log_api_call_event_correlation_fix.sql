-- Plan: PLAN-202512-cloud-migrations-uniqueness-ci-alignment / Step: S02
-- Migration: Fix log_api_call_event to persist correlation_id
-- Purpose: Preserve end-to-end traceability by ensuring api_call_log rows carry correlation_id.

BEGIN;

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
SET search_path TO public, extensions, pg_temp
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
    v_correlation_id UUID;
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

    v_correlation_id := COALESCE(v_job.correlation_id, public.current_correlation_id());

    -- Redact secrets before persisting.
    v_url := public.redact_sensitive_url(v_url);
    v_request_headers := public.redact_sensitive_headers(v_request_headers);
    v_request_body := public.redact_sensitive_json(v_request_body);
    v_response_headers := public.redact_sensitive_headers(v_response_headers);
    v_response_body := public.redact_sensitive_json(v_response_body);

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
        error_message,
        correlation_id
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
        p_error,
        v_correlation_id
    );
END;
$$;

COMMENT ON FUNCTION public.log_api_call_event(UUID, JSONB, JSONB, INT, INT, TEXT)
  IS 'Persist outbound API call audit (trace-aware) sourced from outbound_calls (redacted).';

ALTER FUNCTION public.log_api_call_event(UUID, JSONB, JSONB, INT, INT, TEXT)
  SET search_path = public, extensions, pg_temp;

COMMIT;


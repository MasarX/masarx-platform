-- Migration: Observability log function fixups (correlation + accurate timestamps)
-- Purpose:
--   - Ensure api_call_log rows include correlation_id (for end-to-end tracing).
--   - Ensure decision_log timestamps reflect actual decision time (not transaction start).
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - SSOT (canonical helpers).
-- Date: 2025-12-15

BEGIN;

-------------------------------------------------------------------------------
-- API call logging: include correlation_id for tracing (redaction preserved).
-------------------------------------------------------------------------------

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
        v_job.correlation_id
    );
END;
$$;

-------------------------------------------------------------------------------
-- Decision log helper: use clock_timestamp() so log times are accurate even
-- inside long-running transactions (now() is transaction_timestamp()).
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_decision(
    p_organization_id UUID,
    p_decision_category TEXT,
    p_resource_type TEXT,
    p_resource_id UUID,
    p_decision_point TEXT,
    p_decision_outcome TEXT,
    p_performed_by_system TEXT,
    p_correlation_id UUID DEFAULT NULL,
    p_decision_inputs JSONB DEFAULT '{}'::jsonb,
    p_decision_reason TEXT DEFAULT NULL,
    p_settings_resolution_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_id UUID := gen_random_uuid();
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'log_decision requires organization_id (received NULL for resource_type=% resource_id=%)', p_resource_type, p_resource_id;
    END IF;

    INSERT INTO public.decision_log (
        id,
        organization_id,
        decision_category,
        resource_type,
        resource_id,
        decision_point,
        decision_outcome,
        decision_inputs,
        decision_reason,
        performed_by_system,
        correlation_id,
        settings_resolution_id,
        timestamp
    ) VALUES (
        v_id,
        p_organization_id,
        p_decision_category,
        p_resource_type,
        p_resource_id,
        p_decision_point,
        p_decision_outcome,
        COALESCE(p_decision_inputs, '{}'::jsonb),
        p_decision_reason,
        p_performed_by_system,
        p_correlation_id,
        p_settings_resolution_id,
        clock_timestamp()
    );

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.log_decision(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB, TEXT, UUID)
  IS 'Canonical helper to insert decision_log rows (clock_timestamp for accurate log time), optionally linking settings_resolution_log via settings_resolution_id.';

COMMIT;


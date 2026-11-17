-- Migration: Trace + observability hardening and log RLS
-- Date: 2025-12-01 12:00 UTC

BEGIN;

-------------------------------------------------------------------------------
-- 1) RLS for log tables (service_role only)
-------------------------------------------------------------------------------

ALTER TABLE IF EXISTS public.webhook_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.api_call_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.webhook_log FROM PUBLIC;
REVOKE ALL ON TABLE public.webhook_log FROM anon;
REVOKE ALL ON TABLE public.webhook_log FROM authenticated;
REVOKE ALL ON TABLE public.api_call_log FROM PUBLIC;
REVOKE ALL ON TABLE public.api_call_log FROM anon;
REVOKE ALL ON TABLE public.api_call_log FROM authenticated;

DROP POLICY IF EXISTS webhook_log_service_policy ON public.webhook_log;
CREATE POLICY webhook_log_service_policy
  ON public.webhook_log
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS api_call_log_service_policy ON public.api_call_log;
CREATE POLICY api_call_log_service_policy
  ON public.api_call_log
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 2) Trace propagation for api_call_log
-------------------------------------------------------------------------------

ALTER TABLE public.api_call_log
  ADD COLUMN IF NOT EXISTS correlation_id UUID;

CREATE INDEX IF NOT EXISTS idx_api_call_log_correlation
  ON public.api_call_log(correlation_id);

COMMENT ON COLUMN public.api_call_log.correlation_id IS 'Trace ID propagated from request_contexts / outbound_calls for debugging';

-------------------------------------------------------------------------------
-- 3) Partitioning config coverage for provenance/audit tables
-------------------------------------------------------------------------------

INSERT INTO public.partitioning_config (
    table_name,
    partition_strategy,
    partition_key,
    partition_interval,
    partitions_ahead,
    retention_months,
    config
)
VALUES
    ('settings_resolution_log', 'HASH+RANGE', 'organization_id|resolved_at', 'monthly', 3, 6, '{"hash_modulus":1,"range_interval":"monthly"}'::jsonb),
    ('audit_table_changes', 'HASH+RANGE', 'organization_id|created_at', 'monthly', 3, 6, '{"hash_modulus":1,"range_interval":"monthly"}'::jsonb)
ON CONFLICT (table_name) DO NOTHING;

-------------------------------------------------------------------------------
-- 4) Unified observability view (trace-aware)
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW observability_events_v AS
WITH outbound_org AS (
    SELECT
        oc.id,
        COALESCE(
            s.organization_id,
            NULLIF(oc.context ->> 'organization_id', '')::uuid
        ) AS organization_id
    FROM outbound_calls oc
    LEFT JOIN shipments s ON s.id = oc.shipment_id
)
SELECT
    dl.id AS event_id,
    dl.organization_id,
    'decision_log'::text AS event_source,
    dl.decision_category AS event_type,
    dl.resource_type,
    dl.resource_id,
    dl.correlation_id,
    dl.decision_outcome AS status,
    dl.timestamp AS event_time,
    jsonb_strip_nulls(jsonb_build_object(
        'decision_point', dl.decision_point,
        'decision_reason', dl.decision_reason,
        'performed_by', dl.performed_by_system,
        'settings_resolution_id', dl.settings_resolution_id,
        'decision_inputs', dl.decision_inputs
    )) AS metadata
FROM decision_log dl

UNION ALL

SELECT
    acl.id AS event_id,
    acl.organization_id,
    'api_call_log'::text AS event_source,
    acl.operation AS event_type,
    'api_call'::text AS resource_type,
    acl.provider_id AS resource_id,
    acl.correlation_id,
    CASE
        WHEN acl.response_status BETWEEN 200 AND 299 THEN 'succeeded'
        WHEN acl.response_status IS NULL THEN 'unknown'
        ELSE 'failed'
    END AS status,
    acl.timestamp AS event_time,
    jsonb_strip_nulls(jsonb_build_object(
        'method', acl.method,
        'url', acl.url,
        'response_status', acl.response_status,
        'duration_ms', acl.duration_ms,
        'error_message', acl.error_message,
        'circuit_breaker_state', acl.circuit_breaker_state
    )) AS metadata
FROM api_call_log acl

UNION ALL

SELECT
    we.decision_log_id AS event_id,
    COALESCE(we.organization_id, dl.organization_id) AS organization_id,
    'webhook_http_response'::text AS event_source,
    COALESCE(we.response_outcome, 'response_sent') AS event_type,
    'webhook'::text AS resource_type,
    we.webhook_inbox_id AS resource_id,
    dl.correlation_id,
    COALESCE(we.response_outcome, 'unknown') AS status,
    we.response_created_at AS event_time,
    jsonb_strip_nulls(jsonb_build_object(
        'http_status_code', we.http_status_code,
        'response_mode', we.response_mode,
        'response_reason', we.response_reason,
        'workflow_run_id', we.workflow_run_id,
        'workflow_run_step_id', we.workflow_run_step_id,
        'followup_workflow_run_id', we.followup_workflow_run_id,
        'validation_results', we.validation_results,
        'idempotency_key', we.idempotency_key
    )) AS metadata
FROM webhook_response_events we
JOIN decision_log dl ON dl.id = we.decision_log_id

UNION ALL

SELECT
    oc.id AS event_id,
    outbound_org.organization_id,
    'outbound_calls'::text AS event_source,
    oc.call_type AS event_type,
    oc.target_type AS resource_type,
    oc.target_id AS resource_id,
    oc.correlation_id,
    oc.status,
    COALESCE(oc.completed_at, oc.created_at) AS event_time,
    jsonb_strip_nulls(jsonb_build_object(
        'method', oc.method,
        'url', oc.url,
        'response_status_code', oc.response_status_code,
        'error_message', oc.error_message,
        'latency_ms', oc.latency_ms,
        'priority', oc.priority,
        'workflow_run_step_id', oc.workflow_run_step_id
    )) AS metadata
FROM outbound_calls oc
LEFT JOIN outbound_org ON outbound_org.id = oc.id;

COMMENT ON VIEW observability_events_v IS
    'Unified observability view (decision_log, webhook_http_response, api_call_log, outbound_calls) with correlation_id for end-to-end tracing.';

-------------------------------------------------------------------------------
-- 5) Update log_api_call_event helper to persist correlation_id
-------------------------------------------------------------------------------

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

COMMENT ON FUNCTION log_api_call_event(UUID, JSONB, JSONB, INT, INT, TEXT)
  IS 'Persist outbound API call audit (trace-aware) sourced from outbound_calls.';

ALTER FUNCTION log_api_call_event(UUID, JSONB, JSONB, INT, INT, TEXT)
  SET search_path = public, extensions, pg_temp;

COMMIT;

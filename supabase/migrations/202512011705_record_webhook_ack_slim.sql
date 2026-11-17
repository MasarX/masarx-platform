-- Migration: Simplify record_webhook_ack to log decisions without mutating nonexistent columns
-- Date: 2025-12-01

BEGIN;

CREATE OR REPLACE FUNCTION public.record_webhook_ack(
    p_webhook_inbox_id UUID,
    p_webhook_source_id UUID,
    p_ack_mode TEXT,
    p_ack_status_code INT,
    p_ack_headers JSONB,
    p_ack_body JSONB,
    p_ack_outcome TEXT,
    p_ack_reason TEXT,
    p_validation_results JSONB,
    p_ack_sent_at TIMESTAMPTZ,
    p_idempotency_key TEXT,
    p_policy_settings_id UUID,
    p_policy_scope_type TEXT,
    p_policy_scope_id UUID,
    p_policy_version INT,
    p_workflow_run_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
    v_org UUID;
    v_inputs JSONB;
BEGIN
    SELECT organization_id INTO v_org FROM webhook_inbox WHERE id = p_webhook_inbox_id;
    IF v_org IS NULL THEN
        RAISE EXCEPTION 'webhook_inbox entry % not found when recording acknowledgement', p_webhook_inbox_id;
    END IF;

    v_inputs := jsonb_strip_nulls(jsonb_build_object(
        'ack_mode', p_ack_mode,
        'status', p_ack_status_code,
        'headers', COALESCE(p_ack_headers, '{}'::jsonb),
        'body', p_ack_body,
        'validation_results', COALESCE(p_validation_results, '{}'::jsonb),
        'idempotency_key', p_idempotency_key,
        'policy_settings_id', p_policy_settings_id,
        'policy_scope_type', p_policy_scope_type,
        'policy_scope_id', p_policy_scope_id,
        'policy_version', p_policy_version,
        'workflow_run_id', p_workflow_run_id,
        'ack_sent_at', p_ack_sent_at
    ));

    PERFORM log_decision(
        p_organization_id := v_org,
        p_decision_category := 'http_response_emitted',
        p_resource_type := 'webhook_inbox',
        p_resource_id := p_webhook_inbox_id,
        p_decision_point := 'intake_ack',
        p_decision_outcome := CASE WHEN p_ack_outcome = 'ack_failed' THEN 'response_failed' ELSE 'response_sent' END,
        p_performed_by_system := 'workflow_intake_webhook',
        p_correlation_id := NULL,
        p_decision_inputs := v_inputs,
        p_decision_reason := p_ack_reason
    );
END;
$$;

COMMIT;

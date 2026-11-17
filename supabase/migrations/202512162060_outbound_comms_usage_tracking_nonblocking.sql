-- Plan: PLAN-202512-comms-reply-low-latency / Step: S04
-- Migration: Non-blocking provider_usage_tracking in comms response processing
-- Purpose:
--   - Ensure comms_attempts (SSOT) is always recorded for comms_* outbound responses.
--   - Treat provider_usage_policy as optional for the send pipeline (log + skip on missing/invalid policy).
-- Date: 2025-12-16

BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.process_comms_outbound_response_v1(
  p_job public.outbound_calls,
  p_template public.operation_templates,
  p_response JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_provider_id UUID := NULL;
  v_org_id UUID := NULL;
  v_client_id UUID := NULL;
  v_sender_id UUID := NULL;
  v_period_type TEXT := NULL;
  v_policy_row RECORD;
  v_policy JSONB := NULL;
  v_policy_ctx JSONB := '{}'::jsonb;

  v_parsed JSONB := '{}'::jsonb;
  v_provider_message_id TEXT := NULL;
  v_attempt_number INT := COALESCE(p_job.retry_count, 0) + 1;
BEGIN
  IF p_job.target_type = 'provider' THEN
    v_provider_id := p_job.target_id;
  END IF;

  IF v_provider_id IS NULL THEN
    RETURN jsonb_build_object('handled', FALSE, 'reason', 'missing_provider');
  END IF;

  BEGIN
    v_org_id := NULLIF(p_job.context->>'organization_id', '')::UUID;
  EXCEPTION
    WHEN others THEN v_org_id := NULL;
  END;
  IF v_org_id IS NULL THEN
    v_org_id := public.resolve_organization_id_strict('outbound_call', p_job.id);
  END IF;

  BEGIN
    v_client_id := NULLIF(p_job.context->>'client_id', '')::UUID;
  EXCEPTION
    WHEN others THEN v_client_id := NULL;
  END;

  BEGIN
    v_sender_id := NULLIF(p_job.context->>'sender_id', '')::UUID;
  EXCEPTION
    WHEN others THEN v_sender_id := NULL;
  END;

  IF v_sender_id IS NULL AND p_job.shipment_id IS NOT NULL THEN
    SELECT s.sender_id INTO v_sender_id
      FROM public.shipments s
     WHERE s.id = p_job.shipment_id
     LIMIT 1;
  END IF;

  IF v_client_id IS NULL AND p_job.shipment_id IS NOT NULL THEN
    SELECT s.client_id INTO v_client_id
      FROM public.shipments s
     WHERE s.id = p_job.shipment_id
     LIMIT 1;
  END IF;

  -- Parse provider response using the canonical mapping_config when present.
  IF p_template.mapping_config_id IS NOT NULL THEN
    v_parsed := public.apply_mapping_config(COALESCE(p_response, '{}'::jsonb), p_template.mapping_config_id);
  END IF;

  v_provider_message_id := NULLIF(COALESCE(v_parsed->>'message_id', v_parsed->>'id'), '');

  -- SSOT: Always write comms_attempts for comms_* calls (never blocked by usage policy).
  INSERT INTO public.comms_attempts (
    outbound_call_id,
    provider_id,
    attempt_number,
    status,
    provider_message_id,
    cost,
    timestamp
  )
  VALUES (
    p_job.id,
    v_provider_id,
    v_attempt_number,
    'sent',
    v_provider_message_id,
    p_job.cost,
    now()
  )
  ON CONFLICT (outbound_call_id, attempt_number) DO UPDATE
    SET status = EXCLUDED.status,
        provider_message_id = COALESCE(public.comms_attempts.provider_message_id, EXCLUDED.provider_message_id),
        cost = COALESCE(public.comms_attempts.cost, EXCLUDED.cost);

  v_policy_ctx := jsonb_strip_nulls(
    COALESCE(p_job.context, '{}'::jsonb)
    || jsonb_build_object(
      'organization_id', v_org_id,
      'client_id', v_client_id,
      'sender_id', v_sender_id
    )
  );

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row_from_context('provider_usage_policy', v_policy_ctx)
    LIMIT 1;

  IF NOT FOUND OR v_policy_row.value IS NULL THEN
    PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'provider_usage_tracking',
      p_resource_type := 'outbound_call',
      p_resource_id := p_job.id,
      p_decision_point := 'usage_policy',
      p_decision_outcome := 'skipped_policy_missing',
      p_performed_by_system := 'process_comms_outbound_response_v1',
      p_correlation_id := p_job.correlation_id,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'provider_id', v_provider_id,
        'client_id', v_client_id,
        'sender_id', v_sender_id
      )),
      p_decision_reason := 'provider_usage_policy_missing'
    );

    RETURN jsonb_strip_nulls(jsonb_build_object(
      'handled', TRUE,
      'provider_message_id', v_provider_message_id,
      'attempt_number', v_attempt_number,
      'usage_tracking', 'skipped_policy_missing'
    ));
  END IF;

  v_policy := v_policy_row.value;
  v_period_type := lower(NULLIF(v_policy->>'period_type', ''));
  IF v_period_type IS NULL OR v_period_type NOT IN ('hour', 'day', 'month') THEN
    PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'provider_usage_tracking',
      p_resource_type := 'outbound_call',
      p_resource_id := p_job.id,
      p_decision_point := 'usage_policy',
      p_decision_outcome := 'skipped_policy_invalid',
      p_performed_by_system := 'process_comms_outbound_response_v1',
      p_correlation_id := p_job.correlation_id,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'period_type', v_period_type,
        'provider_id', v_provider_id,
        'client_id', v_client_id,
        'sender_id', v_sender_id
      )),
      p_decision_reason := 'provider_usage_policy_invalid_period_type'
    );

    RETURN jsonb_strip_nulls(jsonb_build_object(
      'handled', TRUE,
      'provider_message_id', v_provider_message_id,
      'attempt_number', v_attempt_number,
      'usage_tracking', 'skipped_policy_invalid'
    ));
  END IF;

  PERFORM public.upsert_provider_usage_tracking(
    p_organization_id := v_org_id,
    p_client_id := v_client_id,
    p_sender_id := v_sender_id,
    p_provider_id := v_provider_id,
    p_period_type := v_period_type,
    p_event_time := now(),
    p_call_count_delta := 1,
    p_actual_cost_delta := COALESCE(p_job.cost, 0)
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'handled', TRUE,
    'provider_message_id', v_provider_message_id,
    'attempt_number', v_attempt_number,
    'usage_tracking', 'ok'
  ));
END;
$$;

COMMENT ON FUNCTION workflow_handlers.process_comms_outbound_response_v1(public.outbound_calls, public.operation_templates, JSONB)
  IS 'Process comms outbound responses: always write comms_attempts; optionally bump provider_usage_tracking when provider_usage_policy is present and valid.';

COMMIT;


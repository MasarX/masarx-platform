-- Migration: Dialog360 inbound status receipts -> comms_attempts updates
-- Purpose:
--   - Dialog360 delivers delivery/read/failed receipts to the same inbound webhook.
--   - Update comms_attempts.status for matching provider_message_id (scoped by organization) without sending auto-replies.
--   - Keep behaviour workflow-driven (execute_comms_reply_v1 routes messages vs receipts based on mapped payload).
-- Date: 2025-12-14

BEGIN;

-------------------------------------------------------------------------------
-- Receipt processor (idempotent)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.process_comms_delivery_receipt(
  p_webhook_id UUID,
  p_webhook_source_id UUID,
  p_comm JSONB,
  p_organization_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_message_id TEXT := NULLIF(COALESCE(p_comm->>'message_id', ''), '');
  v_status TEXT := lower(NULLIF(COALESCE(p_comm->>'status', ''), ''));
  v_error_code TEXT := NULLIF(COALESCE(p_comm->>'status_error_code', ''), '');
  v_error_title TEXT := NULLIF(COALESCE(p_comm->>'status_error_title', ''), '');
  v_error_message TEXT := NULLIF(COALESCE(p_comm->>'status_error_message', ''), '');
  v_error TEXT := NULL;
  v_updated JSONB := '[]'::jsonb;
  v_updated_count INT := 0;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'process_comms_delivery_receipt_missing_org';
  END IF;

  IF v_message_id IS NULL THEN
    RETURN jsonb_build_object('handled', FALSE, 'reason', 'missing_message_id');
  END IF;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object('handled', FALSE, 'reason', 'missing_status', 'message_id', v_message_id);
  END IF;

  v_error := COALESCE(v_error_message, v_error_title);

  WITH updated AS (
    UPDATE public.comms_attempts ca
       SET status = v_status,
           error_code = COALESCE(v_error_code, ca.error_code),
           error_message = COALESCE(v_error, ca.error_message)
      FROM public.providers pr
     WHERE ca.provider_message_id = v_message_id
       AND ca.provider_id = pr.id
       AND pr.organization_id = p_organization_id
     RETURNING ca.id, ca.outbound_call_id, ca.provider_id, ca.attempt_number
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'comms_attempt_id', id,
      'outbound_call_id', outbound_call_id,
      'provider_id', provider_id,
      'attempt_number', attempt_number
    )), '[]'::jsonb),
    COALESCE(count(*), 0)
  INTO v_updated, v_updated_count
  FROM updated;

  PERFORM public.log_decision(
    p_organization_id := p_organization_id,
    p_decision_category := 'provider_callback',
    p_resource_type := 'webhook_inbox',
    p_resource_id := p_webhook_id,
    p_decision_point := 'comms_delivery_receipt',
    p_decision_outcome := v_status,
    p_performed_by_system := 'process_comms_delivery_receipt',
    p_correlation_id := NULL,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'webhook_source_id', p_webhook_source_id,
      'message_id', v_message_id,
      'status', v_status,
      'error_code', v_error_code,
      'error', v_error,
      'updated_count', v_updated_count
    )),
    p_decision_reason := 'Provider delivery/status receipt processed.'
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'handled', TRUE,
    'message_id', v_message_id,
    'status', v_status,
    'updated_count', v_updated_count,
    'updated', v_updated
  ));
END;
$$;

COMMENT ON FUNCTION public.process_comms_delivery_receipt(UUID, UUID, JSONB, UUID)
  IS 'Update comms_attempts status for a provider delivery receipt (scoped by org); logs a provider_callback decision.';

-------------------------------------------------------------------------------
-- Workflow handler: route inbound messages vs status receipts
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_comms_reply_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_response public.workflow_handler_response;
  v_webhook_id UUID;
  v_webhook RECORD;
  v_source RECORD;
  v_transformed JSONB;
  v_comm JSONB;
  v_org_id UUID;
  v_client_id UUID;

  v_reply_result JSONB;
  v_mark_result JSONB;
  v_stop_workflow BOOLEAN := FALSE;
  v_stop_reason TEXT := 'reply_received';

  v_receipt_result JSONB;
BEGIN
  BEGIN
    v_webhook_id := NULLIF(p_run.context->>'webhook_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_webhook_id := NULL;
  END;

  IF v_webhook_id IS NULL THEN
    v_response.status := 'failed';
    v_response.last_error := 'missing_webhook_id';
    v_response.operation_result := jsonb_build_object('error', 'missing_webhook_id');
    RETURN v_response;
  END IF;

  SELECT wi.*
    INTO v_webhook
    FROM public.webhook_inbox wi
   WHERE wi.id = v_webhook_id;

  IF NOT FOUND THEN
    v_response.status := 'failed';
    v_response.last_error := 'webhook_not_found';
    v_response.operation_result := jsonb_build_object('error', 'webhook_not_found', 'webhook_id', v_webhook_id);
    RETURN v_response;
  END IF;

  SELECT ws.id,
         ws.organization_id,
         ws.mapping_config_id,
         ws.sender_id,
         s.client_id
    INTO v_source
    FROM public.webhook_sources ws
    LEFT JOIN public.senders s ON s.id = ws.sender_id
   WHERE ws.id = v_webhook.webhook_source_id;

  IF NOT FOUND THEN
    v_response.status := 'failed';
    v_response.last_error := 'webhook_source_not_found';
    v_response.operation_result := jsonb_build_object('error', 'webhook_source_not_found', 'webhook_source_id', v_webhook.webhook_source_id);
    RETURN v_response;
  END IF;

  v_org_id := COALESCE(
    NULLIF(p_run.context->>'organization_id', '')::UUID,
    v_source.organization_id
  );
  v_client_id := v_source.client_id;

  -- Map payload into a canonical communication object via mapping_configs (row-driven).
  v_transformed := public.apply_mapping_config(v_webhook.raw_payload, v_source.mapping_config_id);
  v_comm := COALESCE(v_transformed->'communication', '{}'::jsonb);

  -- Persist transformed payload for observability/troubleshooting.
  UPDATE public.webhook_inbox
     SET transformed_payload = COALESCE(v_transformed, '{}'::jsonb)
   WHERE id = v_webhook_id;

  -- Status receipt: update comms_attempts and stop (no auto-reply).
  IF NULLIF(COALESCE(v_comm->>'status', ''), '') IS NOT NULL THEN
    v_receipt_result := public.process_comms_delivery_receipt(
      p_webhook_id := v_webhook_id,
      p_webhook_source_id := v_source.id,
      p_comm := v_comm,
      p_organization_id := v_org_id
    );

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'webhook_id', v_webhook_id,
      'receipt', v_receipt_result
    ));
    RETURN v_response;
  END IF;

  -- Inbound message: policy-driven automated reply (queues outbound_calls; no direct network calls).
  v_reply_result := public.send_comms_reply(
    v_webhook_id,
    v_source.id,
    v_comm,
    v_org_id
  );

  v_stop_workflow := COALESCE(NULLIF(v_reply_result->>'stop_workflow', '')::BOOLEAN, FALSE);
  IF COALESCE(NULLIF(v_reply_result->>'opt_out', '')::BOOLEAN, FALSE) THEN
    v_stop_reason := 'opt_out';
  END IF;

  -- Mark reply receipt on the related workflow run (scoped + policy-driven stop).
  v_mark_result := public.worker_action_mark_communication_reply(
    v_webhook_id,
    jsonb_strip_nulls(jsonb_build_object(
      'stop_reason', v_stop_reason,
      'stop_workflow', v_stop_workflow,
      'organization_id', v_org_id,
      'client_id', v_client_id
    )),
    jsonb_build_object('transformed_payload', jsonb_build_object('communication', v_comm))
  );

  v_response.status := 'completed';
  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'webhook_id', v_webhook_id,
    'reply', v_reply_result,
    'mark_reply', v_mark_result
  ));
  v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
    'comms_reply', v_reply_result
  ));
  RETURN v_response;
EXCEPTION
  WHEN others THEN
    v_response.status := 'failed';
    v_response.last_error := SQLERRM;
    v_response.operation_result := jsonb_build_object('error', SQLERRM);
    RETURN v_response;
END;
$$;

COMMIT;


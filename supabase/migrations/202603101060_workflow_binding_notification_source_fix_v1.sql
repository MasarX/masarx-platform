-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- Purpose:
-- - Preserve originating subsystem provenance on dynamic workflow-driven notifications
--   instead of hardcoding outbound_calls.context.source='workflow_binding'.
-- - Keep binding_key/stage_key follow-up notifications auditable after
--   run_workflow_binding_stage_v1 dispatches.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603101060_workflow_binding_notification_source_fix_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_recipient_notification_dynamic_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload_path TEXT := COALESCE(
    NULLIF(btrim(COALESCE(v_meta->>'notification_path', '')), ''),
    '$.context.binding_payload.notification'
  );
  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'notification');
  v_notification JSONB := NULL;
  v_recipient_id UUID := NULL;
  v_org_id UUID := NULL;
  v_support_case_id UUID := NULL;
  v_channel_mode TEXT := NULL;
  v_channel TEXT := NULL;
  v_call_type TEXT := NULL;
  v_priority INT := 100;
  v_max_retries INT := 3;
  v_message TEXT := NULL;
  v_stage TEXT := NULL;
  v_payload JSONB := '{}'::jsonb;
  v_context JSONB := '{}'::jsonb;
  v_source TEXT := NULL;
  v_recipient RECORD;
  v_outbound_id UUID := NULL;
  v_resp public.workflow_handler_response;
BEGIN
  v_notification := public.safe_jsonpath_query_first(
    jsonb_build_object(
      'context', v_ctx,
      'operation_result', COALESCE(p_operation_result, '{}'::jsonb)
    ),
    v_payload_path
  );

  IF v_notification IS NULL OR jsonb_typeof(v_notification) <> 'object' THEN
    RAISE EXCEPTION 'recipient_notification_dynamic: missing object at % (workflow_run_id=% step_id=%)', v_payload_path, p_run.id, p_step.id;
  END IF;

  BEGIN v_recipient_id := NULLIF(v_notification->>'recipient_id', '')::UUID; EXCEPTION WHEN others THEN v_recipient_id := NULL; END;
  BEGIN v_org_id := NULLIF(COALESCE(v_notification->>'organization_id', v_ctx->>'organization_id'), '')::UUID; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_support_case_id := NULLIF(v_notification->>'support_case_id', '')::UUID; EXCEPTION WHEN others THEN v_support_case_id := NULL; END;
  v_stage := NULLIF(lower(btrim(COALESCE(v_notification->>'stage', ''))), '');
  v_message := NULLIF(btrim(COALESCE(v_notification->>'message', '')), '');
  v_channel_mode := lower(COALESCE(NULLIF(btrim(COALESCE(v_notification->>'channel', '')), ''), 'best_available'));
  BEGIN v_priority := NULLIF(btrim(COALESCE(v_notification->>'priority', '')), '')::INT; EXCEPTION WHEN others THEN v_priority := 100; END;
  BEGIN v_max_retries := NULLIF(btrim(COALESCE(v_notification->>'max_retries', '')), '')::INT; EXCEPTION WHEN others THEN v_max_retries := 3; END;
  v_payload := COALESCE(v_notification->'payload', '{}'::jsonb);
  IF jsonb_typeof(v_payload) <> 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  IF v_recipient_id IS NULL OR v_message IS NULL THEN
    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_build_object('queued', FALSE, 'reason', 'recipient_or_message_missing');
    RETURN v_resp;
  END IF;

  SELECT r.id, NULLIF(btrim(r.email), '') AS email, NULLIF(btrim(r.phone_number), '') AS phone_number
    INTO v_recipient
    FROM public.recipients r
   WHERE r.id = v_recipient_id
   LIMIT 1;

  IF v_recipient.id IS NULL THEN
    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_build_object('queued', FALSE, 'reason', 'recipient_not_found');
    RETURN v_resp;
  END IF;

  IF v_channel_mode = 'sms' THEN
    IF v_recipient.phone_number IS NULL THEN
      v_resp.status := 'completed';
      v_resp.operation_result := jsonb_build_object('queued', FALSE, 'reason', 'recipient_phone_missing');
      RETURN v_resp;
    END IF;
    v_channel := 'sms';
    v_call_type := 'comms_sms';
  ELSIF v_channel_mode = 'email' THEN
    IF v_recipient.email IS NULL THEN
      v_resp.status := 'completed';
      v_resp.operation_result := jsonb_build_object('queued', FALSE, 'reason', 'recipient_email_missing');
      RETURN v_resp;
    END IF;
    v_channel := 'email';
    v_call_type := 'comms_email';
  ELSE
    IF v_recipient.email IS NOT NULL THEN
      v_channel := 'email';
      v_call_type := 'comms_email';
    ELSIF v_recipient.phone_number IS NOT NULL THEN
      v_channel := 'sms';
      v_call_type := 'comms_sms';
    ELSE
      v_resp.status := 'completed';
      v_resp.operation_result := jsonb_build_object('queued', FALSE, 'reason', 'recipient_contact_missing');
      RETURN v_resp;
    END IF;
  END IF;

  v_source := COALESCE(
    NULLIF(btrim(COALESCE(v_notification->>'source', '')), ''),
    NULLIF(btrim(COALESCE(v_ctx #>> ARRAY['actor', 'system'], '')), ''),
    NULLIF(btrim(COALESCE(v_ctx #>> ARRAY['binding', 'source_function'], '')), ''),
    'workflow_binding'
  );

  v_context := jsonb_strip_nulls(
    jsonb_build_object(
      'source', v_source,
      'binding', v_ctx->'binding',
      'support_case_id', v_support_case_id,
      'organization_id', v_org_id,
      'stage', v_stage
    )
  );

  INSERT INTO public.outbound_calls (
    call_type,
    target_type,
    target_id,
    method,
    url,
    headers,
    body,
    priority,
    max_retries,
    context,
    correlation_id
  )
  VALUES (
    v_call_type,
    'recipient',
    v_recipient_id,
    'POST',
    format('comms://%s', v_channel),
    '{}'::jsonb,
    jsonb_strip_nulls(
      jsonb_build_object(
        'stage', v_stage,
        'message', v_message,
        'support_case_id', v_support_case_id,
        'payload', v_payload
      )
    ),
    GREATEST(COALESCE(v_priority, 100), 0),
    GREATEST(COALESCE(v_max_retries, 3), 0),
    v_context,
    NULL
  )
  RETURNING id INTO v_outbound_id;

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(
    jsonb_build_object(
      'queued', TRUE,
      'channel', v_channel,
      'outbound_call_id', v_outbound_id
    )
  );
  v_resp.context_patch := jsonb_build_object(v_context_key, v_resp.operation_result);
  RETURN v_resp;
END;
$function$;

SELECT pg_advisory_unlock(hashtext('202603101060_workflow_binding_notification_source_fix_v1'));
COMMIT;

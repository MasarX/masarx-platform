-- Plan: PLAN-202603-customer-shipment-change-review-flow / Step: S04
-- Fix public tracking request creation to preserve idempotency on the partial support_cases index.

CREATE OR REPLACE FUNCTION public.public_tracking_submit_request_v2(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_token TEXT := NULLIF(btrim(COALESCE(v_input->>'session_token', '')), '');
  v_ip_hash TEXT := NULLIF(btrim(COALESCE(v_input->>'ip_hash', '')), '');
  v_request_type TEXT := public.public_tracking_request_type_key_v1(v_input->>'request_type');
  v_payload JSONB := COALESCE(v_input->'payload', '{}'::jsonb);
  v_requester_channel TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'requester_channel', '')), ''), 'public_tracking');
  v_global_policy JSONB := public.public_tracking_policy_v1('{}'::jsonb);
  v_rate RECORD;
  v_session RECORD;
  v_policy JSONB;
  v_action_key TEXT;
  v_execution_mode TEXT;
  v_enabled BOOLEAN := FALSE;
  v_priority TEXT := 'medium';
  v_sla_minutes INT := 60;
  v_requested_date DATE := NULL;
  v_available_date BOOLEAN := FALSE;
  v_case_id UUID;
  v_case_version INT;
  v_inserted BOOLEAN := FALSE;
  v_idempotency_key TEXT;
  v_before_snapshot JSONB;
  v_requested_snapshot JSONB;
  v_current_snapshot JSONB;
  v_event_payload JSONB;
  v_task_result JSONB := '{}'::jsonb;
  v_apply_result JSONB := '{}'::jsonb;
  v_case_metadata JSONB;
BEGIN
  IF v_token IS NULL OR v_ip_hash IS NULL OR v_request_type IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
  END IF;

  SELECT * INTO v_rate
  FROM public.public_tracking_rate_limit_state_v1(v_global_policy, 'request', v_ip_hash)
  LIMIT 1;

  IF COALESCE(v_rate.recent_requests, 0) >= COALESCE(v_rate.max_requests, 1) THEN
    PERFORM public.public_tracking_log_event_v1('request', v_ip_hash, NULL, 'rate_limited');
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'rate_limited'));
  END IF;

  SELECT
    ts.id,
    ts.organization_id,
    ts.client_id,
    ts.sender_id,
    ts.shipment_id,
    ts.recipient_id,
    s.tracking_number,
    s.client_reference_number,
    s.carrier_reference_number
  INTO v_session
  FROM public.tracking_sessions ts
  JOIN public.shipments s
    ON s.id = ts.shipment_id
   AND s.client_id = ts.client_id
  WHERE ts.status = 'active'
    AND (ts.expires_at IS NULL OR ts.expires_at > workflow_now())
    AND ts.token_hash = crypt(v_token, ts.token_hash)
  ORDER BY ts.created_at DESC
  LIMIT 1;

  IF v_session.id IS NULL THEN
    PERFORM public.public_tracking_log_event_v1('request', v_ip_hash, NULL, 'invalid_session');
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_session'));
  END IF;

  v_policy := public.public_tracking_policy_v1(jsonb_build_object(
    'organization_id', v_session.organization_id,
    'client_id', v_session.client_id,
    'sender_id', v_session.sender_id
  ));
  v_action_key := public.public_tracking_policy_action_key_v1(v_request_type);
  v_enabled := public.public_tracking_bool_v1(v_policy, ARRAY['actions', v_action_key, 'enabled'], TRUE);
  v_priority := public.public_tracking_text_v1(v_policy, ARRAY['actions', v_action_key, 'priority'], 'medium');
  v_sla_minutes := public.public_tracking_int_v1(v_policy, ARRAY['actions', v_action_key, 'sla_minutes'], 60, 1, 10080);
  v_execution_mode := public.public_tracking_execution_mode_v1(v_policy, v_request_type);

  IF v_request_type = 'reschedule_date' THEN
    BEGIN
      v_requested_date := NULLIF(v_payload->>'requested_date', '')::DATE;
    EXCEPTION
      WHEN others THEN
        v_requested_date := NULL;
    END;

    IF v_requested_date IS NOT NULL THEN
      BEGIN
        SELECT EXISTS (
          SELECT 1
          FROM public.list_delivery_slots_v1(jsonb_build_object(
            'shipment_id', v_session.shipment_id,
            'client_id', v_session.client_id,
            'start_date', workflow_now()::date,
            'days', public.public_tracking_int_v1(v_policy, ARRAY['actions','reschedule','horizon_days'], 7, 1, 60),
            'include_unavailable', FALSE
          ))
          WHERE is_available IS TRUE
            AND slot_date = v_requested_date
        )
        INTO v_available_date;
      EXCEPTION
        WHEN others THEN
          v_available_date := FALSE;
      END;
    END IF;

    IF NOT v_enabled OR v_requested_date IS NULL OR v_available_date IS DISTINCT FROM TRUE THEN
      PERFORM public.public_tracking_log_event_v1('request', v_ip_hash, NULL, 'invalid_request', v_session.organization_id, v_session.client_id, v_session.shipment_id, v_session.id);
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
    END IF;
  ELSIF v_request_type = 'location_change' THEN
    IF NOT v_enabled
      OR NULLIF(btrim(COALESCE(v_payload->>'address_text', '')), '') IS NULL
      OR NULLIF(btrim(COALESCE(v_payload->>'short_national_address', '')), '') IS NULL
      OR NULLIF(v_payload #>> ARRAY['map_pin','lat'], '') IS NULL
      OR NULLIF(v_payload #>> ARRAY['map_pin','lng'], '') IS NULL THEN
      PERFORM public.public_tracking_log_event_v1('request', v_ip_hash, NULL, 'invalid_request', v_session.organization_id, v_session.client_id, v_session.shipment_id, v_session.id);
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
    END IF;
  ELSE
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
  END IF;

  v_before_snapshot := public.public_tracking_shipment_snapshot_v1(v_session.shipment_id, v_session.client_id);
  v_requested_snapshot := public.public_tracking_requested_snapshot_v1(v_request_type, v_before_snapshot, v_payload);
  v_current_snapshot := v_before_snapshot;
  v_event_payload := public.public_tracking_event_payload_v1(v_request_type, v_before_snapshot, v_requested_snapshot);

  v_case_metadata := jsonb_strip_nulls(
    jsonb_build_object(
      'source', 'public_tracking',
      'request_type', v_request_type,
      'request_outcome', 'pending_review',
      'requester_channel', v_requester_channel,
      'session_id', v_session.id,
      'recipient_id', v_session.recipient_id,
      'tracking_number', v_session.tracking_number,
      'client_reference_number', NULLIF(btrim(v_session.client_reference_number), ''),
      'carrier_reference_number', NULLIF(btrim(v_session.carrier_reference_number), ''),
      'execution_mode', v_execution_mode,
      'notes', NULLIF(btrim(COALESCE(v_payload->>'notes', '')), ''),
      'before_snapshot', v_before_snapshot,
      'requested_snapshot', v_requested_snapshot,
      'current_snapshot', v_current_snapshot
    )
  );
  v_case_metadata := public.deep_merge_jsonb(v_case_metadata, v_event_payload);

  v_idempotency_key := encode(
    digest(
      v_session.shipment_id::TEXT || ':' || v_request_type || ':' || COALESCE(v_requested_snapshot::TEXT, ''),
      'sha256'
    ),
    'hex'
  );

  BEGIN
    INSERT INTO public.support_cases (
      organization_id,
      client_id,
      sender_id,
      resource_type,
      resource_id,
      status,
      priority,
      sla_minutes,
      sla_due_at,
      opened_at,
      idempotency_key,
      metadata,
      created_at,
      updated_at
    )
    VALUES (
      v_session.organization_id,
      v_session.client_id,
      v_session.sender_id,
      'shipment',
      v_session.shipment_id,
      'open',
      v_priority,
      v_sla_minutes,
      workflow_now() + make_interval(mins => v_sla_minutes),
      workflow_now(),
      v_idempotency_key,
      v_case_metadata,
      workflow_now(),
      workflow_now()
    )
    RETURNING id, version INTO v_case_id, v_case_version;

    v_inserted := TRUE;
  EXCEPTION
    WHEN unique_violation THEN
      v_inserted := FALSE;
  END;

  IF NOT v_inserted THEN
    SELECT sc.id, sc.version, sc.metadata
      INTO v_case_id, v_case_version, v_case_metadata
      FROM public.support_cases sc
     WHERE sc.organization_id = v_session.organization_id
       AND sc.idempotency_key = v_idempotency_key
     LIMIT 1;

    RETURN jsonb_build_object(
      'ok', TRUE,
      'submitted', FALSE,
      'deduped', TRUE,
      'support_case_id', v_case_id,
      'request_type', v_request_type,
      'outcome', COALESCE(v_case_metadata->>'request_outcome', 'pending_review'),
      'tracking', public.public_tracking_build_payload_v1(v_session.id, v_policy)
    );
  END IF;

  INSERT INTO public.support_case_events (
    support_case_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_system,
    payload,
    idempotency_key,
    case_version,
    created_at
  )
  VALUES (
    v_case_id,
    v_session.organization_id,
    'requested',
    NULL,
    'open',
    'public_tracking',
    public.deep_merge_jsonb(v_event_payload, jsonb_build_object('request_outcome', 'pending_review')),
    format('customer-shipment-change:requested:%s', v_case_id),
    COALESCE(v_case_version, 1),
    workflow_now()
  );

  PERFORM public.public_tracking_emit_support_message_v1(
    v_case_id,
    v_session.organization_id,
    'inbound',
    'in_app',
    'public_tracking',
    COALESCE(
      NULLIF(btrim(COALESCE(v_payload->>'notes', '')), ''),
      format('Customer requested %s via public tracking.', replace(v_request_type, '_', ' '))
    ),
    jsonb_build_object('request_type', v_request_type)
  );

  IF public.public_tracking_bool_v1(v_policy, ARRAY['notifications','requester_received'], TRUE) THEN
    PERFORM public.public_tracking_enqueue_recipient_notification_v1(
      v_case_id,
      v_session.organization_id,
      v_session.recipient_id,
      'received',
      format('We received your %s request.', replace(v_request_type, '_', ' ')),
      jsonb_build_object('change_summary', v_case_metadata->>'change_summary')
    );
  END IF;

  IF v_execution_mode = 'review_required' THEN
    BEGIN
      v_task_result := public.public_tracking_create_reviewer_task_v1(
        v_case_id,
        v_session.organization_id,
        v_policy,
        jsonb_build_object(
          'support_case_id', v_case_id,
          'tracking_number', v_session.tracking_number,
          'change_summary', v_case_metadata->>'change_summary',
          'request_type', v_request_type
        )
      );
    EXCEPTION
      WHEN others THEN
        v_task_result := jsonb_build_object('queued', FALSE, 'reason', left(SQLERRM, 800));
    END;

    UPDATE public.support_cases
       SET metadata = public.deep_merge_jsonb(
             metadata,
             jsonb_build_object(
               'request_outcome', 'pending_review',
               'review_task', v_task_result
             )
           ),
           updated_at = workflow_now()
     WHERE id = v_case_id;

    RETURN jsonb_build_object(
      'ok', TRUE,
      'submitted', TRUE,
      'support_case_id', v_case_id,
      'request_type', v_request_type,
      'outcome', 'pending_review',
      'tracking', public.public_tracking_build_payload_v1(v_session.id, v_policy)
    );
  END IF;

  v_apply_result := public.public_tracking_apply_support_case_v1(
    jsonb_build_object(
      'support_case_id', v_case_id,
      'actor_system', 'public_tracking'
    )
  );

  IF COALESCE((v_apply_result->>'ok')::BOOLEAN, FALSE) THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'submitted', TRUE,
      'support_case_id', v_case_id,
      'request_type', v_request_type,
      'outcome', 'applied',
      'tracking', public.public_tracking_build_payload_v1(v_session.id, v_policy)
    );
  END IF;

  IF v_execution_mode = 'auto_apply_with_fallback_to_review' THEN
    BEGIN
      v_task_result := public.public_tracking_create_reviewer_task_v1(
        v_case_id,
        v_session.organization_id,
        v_policy,
        jsonb_build_object(
          'support_case_id', v_case_id,
          'tracking_number', v_session.tracking_number,
          'change_summary', v_case_metadata->>'change_summary',
          'request_type', v_request_type,
          'fallback_reason', COALESCE(v_apply_result #>> ARRAY['error','code'], 'apply_failed')
        )
      );
    EXCEPTION
      WHEN others THEN
        v_task_result := jsonb_build_object('queued', FALSE, 'reason', left(SQLERRM, 800));
    END;

    UPDATE public.support_cases
       SET status = 'open',
           status_reason = 'apply_failed_pending_review',
           version = version + 1,
           metadata = public.deep_merge_jsonb(
             metadata,
             jsonb_strip_nulls(
               jsonb_build_object(
                 'request_outcome', 'pending_review',
                 'last_apply_error', v_apply_result->'error',
                 'review_task', v_task_result
               )
             )
           ),
           updated_at = workflow_now()
     WHERE id = v_case_id
     RETURNING version INTO v_case_version;

    INSERT INTO public.support_case_events (
      support_case_id,
      organization_id,
      event_type,
      from_status,
      to_status,
      actor_system,
      payload,
      idempotency_key,
      case_version,
      created_at
    )
    VALUES (
      v_case_id,
      v_session.organization_id,
      'apply_failed_pending_review',
      'open',
      'open',
      'public_tracking',
      public.public_tracking_event_payload_v1(
        v_request_type,
        v_before_snapshot,
        v_requested_snapshot,
        jsonb_build_object(
          'apply_outcome', 'failed_pending_review',
          'failure_reason', COALESCE(v_apply_result #>> ARRAY['error','code'], 'apply_failed'),
          'review_task', v_task_result,
          'current_snapshot', v_before_snapshot
        )
      ),
      format('customer-shipment-change:apply-failed-pending-review:%s:%s', v_case_id, v_case_version),
      v_case_version,
      workflow_now()
    );

    RETURN jsonb_build_object(
      'ok', TRUE,
      'submitted', TRUE,
      'support_case_id', v_case_id,
      'request_type', v_request_type,
      'outcome', 'pending_review',
      'tracking', public.public_tracking_build_payload_v1(v_session.id, v_policy)
    );
  END IF;

  UPDATE public.support_cases
     SET status = 'resolved',
         status_reason = 'rejected',
         resolved_at = workflow_now(),
         version = version + 1,
         metadata = public.deep_merge_jsonb(
           metadata,
           jsonb_build_object(
             'request_outcome', 'rejected',
             'last_apply_error', v_apply_result->'error',
             'current_snapshot', v_before_snapshot
           )
         ),
         updated_at = workflow_now()
   WHERE id = v_case_id
   RETURNING version INTO v_case_version;

  INSERT INTO public.support_case_events (
    support_case_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_system,
    payload,
    idempotency_key,
    case_version,
    created_at
  )
  VALUES (
    v_case_id,
    v_session.organization_id,
    'rejected',
    'open',
    'resolved',
    'public_tracking',
    public.public_tracking_event_payload_v1(
      v_request_type,
      v_before_snapshot,
      v_requested_snapshot,
      jsonb_build_object(
        'apply_outcome', 'rejected',
        'failure_reason', COALESCE(v_apply_result #>> ARRAY['error','code'], 'apply_failed'),
        'current_snapshot', v_before_snapshot
      )
    ),
    format('customer-shipment-change:rejected:%s:%s', v_case_id, v_case_version),
    v_case_version,
    workflow_now()
  );

  IF public.public_tracking_bool_v1(v_policy, ARRAY['notifications','requester_rejected'], TRUE) THEN
    PERFORM public.public_tracking_enqueue_recipient_notification_v1(
      v_case_id,
      v_session.organization_id,
      v_session.recipient_id,
      'rejected',
      format('Your %s request was rejected.', replace(v_request_type, '_', ' ')),
      jsonb_build_object('reason', COALESCE(v_apply_result #>> ARRAY['error','code'], 'apply_failed'))
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'submitted', TRUE,
    'support_case_id', v_case_id,
    'request_type', v_request_type,
    'outcome', 'rejected',
    'tracking', public.public_tracking_build_payload_v1(v_session.id, v_policy)
  );
END;
$function$;

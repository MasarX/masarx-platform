-- B5 audit repair: keep idempotent shipment-review success bound to canonical readback.

BEGIN;
SELECT pg_advisory_lock(hashtext('202608161750_b5_public_tracking_review_readback_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.public_tracking_review_request_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_support_case_id UUID := NULL;
  v_decision TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_input->>'decision', '')), ''), ''));
  v_reason TEXT := NULLIF(btrim(COALESCE(v_input->>'reason', '')), '');
  v_user_id UUID := NULL;
  v_case RECORD;
  v_policy JSONB;
  v_result JSONB := '{}'::jsonb;
  v_current_snapshot JSONB := '{}'::jsonb;
BEGIN
  BEGIN v_support_case_id := NULLIF(v_input->>'support_case_id', '')::UUID; EXCEPTION WHEN others THEN v_support_case_id := NULL; END;
  v_user_id := public.public_tracking_assert_reviewer_v1();

  IF v_support_case_id IS NULL OR v_decision NOT IN ('approve', 'approved', 'reject', 'rejected') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
  END IF;

  IF v_decision = 'approve' THEN
    v_decision := 'approved';
  ELSIF v_decision = 'reject' THEN
    v_decision := 'rejected';
  END IF;

  SELECT
    sc.id,
    sc.organization_id,
    sc.client_id,
    sc.sender_id,
    sc.resource_id,
    sc.status,
    sc.status_reason,
    sc.version,
    sc.request_source,
    sc.request_type_key,
    sc.metadata
  INTO v_case
  FROM public.support_cases sc
  WHERE sc.id = v_support_case_id
  FOR UPDATE;

  IF v_case.id IS NULL OR v_case.request_source <> 'public_tracking' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF NOT public.is_platform_user() AND v_case.organization_id <> public.current_user_org_id() THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'forbidden'));
  END IF;

  IF v_case.status = 'resolved' THEN
    v_current_snapshot := COALESCE(
      v_case.metadata->'current_snapshot',
      public.public_tracking_shipment_snapshot_v1(v_case.resource_id, v_case.client_id),
      '{}'::jsonb
    );

    RETURN jsonb_build_object(
      'ok', TRUE,
      'support_case_id', v_case.id,
      'outcome', COALESCE(v_case.metadata->>'request_outcome', CASE WHEN v_case.status_reason = 'applied' THEN 'applied' ELSE 'rejected' END),
      'already_processed', TRUE,
      'current_snapshot', v_current_snapshot
    );
  END IF;

  v_policy := public.public_tracking_policy_v1(jsonb_build_object(
    'organization_id', v_case.organization_id,
    'client_id', v_case.client_id,
    'sender_id', v_case.sender_id
  ));

  IF v_decision = 'approved' THEN
    v_result := public.public_tracking_apply_support_case_v1(
      jsonb_build_object(
        'support_case_id', v_case.id,
        'actor_user_id', v_user_id,
        'actor_system', 'console.customer_shipment_changes'
      )
    );

    IF COALESCE((v_result->>'ok')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
      v_current_snapshot := COALESCE(
        v_result->'current_snapshot',
        public.public_tracking_shipment_snapshot_v1(v_case.resource_id, v_case.client_id),
        '{}'::jsonb
      );

      UPDATE public.support_cases
         SET status = 'open',
             status_reason = 'apply_failed_pending_review',
             version = version + 1,
             metadata = public.deep_merge_jsonb(
               metadata,
               jsonb_strip_nulls(
                 jsonb_build_object(
                   'request_outcome', 'pending_review',
                   'last_apply_error', v_result->'error',
                   'current_snapshot', v_current_snapshot,
                   'review_reason', v_reason
                 )
               )
             ),
             updated_at = workflow_now()
       WHERE id = v_case.id
       RETURNING version, metadata INTO v_case.version, v_case.metadata;

      INSERT INTO public.support_case_events (
        support_case_id,
        organization_id,
        event_type,
        from_status,
        to_status,
        actor_user_id,
        actor_system,
        payload,
        idempotency_key,
        case_version,
        created_at
      )
      VALUES (
        v_case.id,
        v_case.organization_id,
        'apply_failed',
        v_case.status,
        'open',
        v_user_id,
        'console.customer_shipment_changes',
        public.public_tracking_event_payload_v1(
          v_case.request_type_key,
          COALESCE(v_case.metadata->'before_snapshot', '{}'::jsonb),
          COALESCE(v_case.metadata->'requested_snapshot', '{}'::jsonb),
          jsonb_strip_nulls(
            jsonb_build_object(
              'apply_outcome', 'failed',
              'failure_reason', COALESCE(v_result #>> ARRAY['error','code'], 'apply_failed'),
              'current_snapshot', v_current_snapshot,
              'reason', v_reason
            )
          )
        ),
        format('customer-shipment-change:review-apply-failed:%s:%s', v_case.id, v_case.version),
        v_case.version,
        workflow_now()
      );

      RETURN v_result;
    END IF;

    RETURN jsonb_build_object(
      'ok', TRUE,
      'support_case_id', v_case.id,
      'outcome', 'applied',
      'current_snapshot', v_result->'current_snapshot'
    );
  END IF;

  v_current_snapshot := public.public_tracking_shipment_snapshot_v1(v_case.resource_id, v_case.client_id);

  UPDATE public.support_cases
     SET status = 'resolved',
         status_reason = 'rejected',
         resolved_at = workflow_now(),
         version = version + 1,
         metadata = public.deep_merge_jsonb(
           metadata,
           jsonb_strip_nulls(
             jsonb_build_object(
               'request_outcome', 'rejected',
               'current_snapshot', v_current_snapshot,
               'review_reason', v_reason
             )
           )
         ),
         updated_at = workflow_now()
   WHERE id = v_case.id
   RETURNING version, metadata INTO v_case.version, v_case.metadata;

  INSERT INTO public.support_case_events (
    support_case_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_system,
    payload,
    idempotency_key,
    case_version,
    created_at
  )
  VALUES (
    v_case.id,
    v_case.organization_id,
    'rejected',
    v_case.status,
    'resolved',
    v_user_id,
    'console.customer_shipment_changes',
    public.public_tracking_event_payload_v1(
      v_case.request_type_key,
      COALESCE(v_case.metadata->'before_snapshot', '{}'::jsonb),
      COALESCE(v_case.metadata->'requested_snapshot', '{}'::jsonb),
      jsonb_strip_nulls(
        jsonb_build_object(
          'reason', v_reason,
          'current_snapshot', v_current_snapshot,
          'request_outcome', 'rejected'
        )
      )
    ),
    format('customer-shipment-change:review-rejected:%s:%s', v_case.id, v_case.version),
    v_case.version,
    workflow_now()
  );

  PERFORM public.public_tracking_emit_support_message_v1(
    v_case.id,
    v_case.organization_id,
    'internal',
    'internal',
    'console.customer_shipment_changes',
    COALESCE(v_reason, format('Customer shipment change rejected (%s).', v_case.request_type_key)),
    jsonb_build_object('request_outcome', 'rejected')
  );

  IF public.public_tracking_bool_v1(v_policy, ARRAY['notifications','requester_rejected'], TRUE) THEN
    PERFORM public.public_tracking_enqueue_recipient_notification_v1(
      v_case.id,
      v_case.organization_id,
      NULLIF(v_case.metadata->>'recipient_id', '')::UUID,
      'rejected',
      format('Your %s request was rejected.', replace(v_case.request_type_key, '_', ' ')),
      jsonb_strip_nulls(jsonb_build_object('reason', v_reason))
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'support_case_id', v_case.id,
    'outcome', 'rejected',
    'current_snapshot', v_current_snapshot
  );
END;
$function$;

COMMENT ON FUNCTION public.public_tracking_review_request_v1(JSONB)
  IS 'Reviews a public tracking request and always returns matching canonical shipment readback for terminal success.';

COMMIT;

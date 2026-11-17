-- Plan: PLAN-202603-landing-public-tracking-page / Step: S04
-- Migration: Public tracking support case idempotency fix v1
-- Date: 2026-03-06
--
-- Purpose:
--   - Fix public_tracking_create_request_v1 to avoid ON CONFLICT against the
--     partial unique index on support_cases(organization_id, idempotency_key).
--   - Preserve request idempotency by handling duplicate inserts via
--     unique_violation and re-reading the existing case.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061350_public_tracking_support_case_conflict_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.public_tracking_create_request_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_token TEXT := NULLIF(btrim(COALESCE(v_input->>'session_token', '')), '');
  v_ip_hash TEXT := NULLIF(btrim(COALESCE(v_input->>'ip_hash', '')), '');
  v_request_type TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'request_type', '')), ''));
  v_payload JSONB := COALESCE(v_input->'payload', '{}'::jsonb);
  v_global_policy JSONB := public.public_tracking_policy_v1('{}'::jsonb);
  v_rate RECORD;
  v_session RECORD;
  v_policy JSONB;
  v_enabled BOOLEAN := FALSE;
  v_priority TEXT := 'medium';
  v_sla_minutes INT := 60;
  v_requested_date DATE := NULL;
  v_address_text TEXT := NULLIF(btrim(COALESCE(v_payload->>'address_text', '')), '');
  v_short_national_address TEXT := NULLIF(btrim(COALESCE(v_payload->>'short_national_address', '')), '');
  v_notes TEXT := NULLIF(btrim(COALESCE(v_payload->>'notes', '')), '');
  v_lat NUMERIC := NULL;
  v_lng NUMERIC := NULL;
  v_available_date BOOLEAN := FALSE;
  v_case_id UUID;
  v_case_version INT;
  v_inserted BOOLEAN := FALSE;
  v_idempotency_key TEXT;
  v_message_body TEXT;
  v_metadata JSONB;
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
    ts.expires_at,
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

  IF NOT FOUND THEN
    PERFORM public.public_tracking_log_event_v1('request', v_ip_hash, NULL, 'invalid_session');
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_session'));
  END IF;

  v_policy := public.public_tracking_policy_v1(jsonb_build_object(
    'organization_id', v_session.organization_id,
    'client_id', v_session.client_id,
    'sender_id', v_session.sender_id
  ));

  IF v_request_type = 'reschedule_date' THEN
    v_enabled := public.public_tracking_bool_v1(v_policy, ARRAY['actions','reschedule','enabled'], TRUE);
    v_priority := COALESCE(NULLIF(v_policy #>> ARRAY['actions','reschedule','priority'], ''), 'medium');
    v_sla_minutes := public.public_tracking_int_v1(v_policy, ARRAY['actions','reschedule','sla_minutes'], 120, 1, 10080);
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

    IF NOT v_enabled OR v_requested_date IS NULL OR v_available_date IS FALSE THEN
      PERFORM public.public_tracking_log_event_v1(
        'request',
        v_ip_hash,
        NULL,
        'invalid_request',
        v_session.organization_id,
        v_session.client_id,
        v_session.shipment_id,
        v_session.id
      );
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
    END IF;

    v_message_body := COALESCE(v_notes, format('Public tracking request: reschedule to %s', v_requested_date::TEXT));
  ELSIF v_request_type = 'location_change' THEN
    v_enabled := public.public_tracking_bool_v1(v_policy, ARRAY['actions','location_change','enabled'], TRUE);
    v_priority := COALESCE(NULLIF(v_policy #>> ARRAY['actions','location_change','priority'], ''), 'high');
    v_sla_minutes := public.public_tracking_int_v1(v_policy, ARRAY['actions','location_change','sla_minutes'], 60, 1, 10080);

    BEGIN
      v_lat := NULLIF(v_payload #>> ARRAY['map_pin','lat'], '')::NUMERIC;
    EXCEPTION
      WHEN others THEN
        v_lat := NULL;
    END;
    BEGIN
      v_lng := NULLIF(v_payload #>> ARRAY['map_pin','lng'], '')::NUMERIC;
    EXCEPTION
      WHEN others THEN
        v_lng := NULL;
    END;

    IF NOT v_enabled
      OR v_address_text IS NULL
      OR v_short_national_address IS NULL
      OR v_lat IS NULL
      OR v_lng IS NULL THEN
      PERFORM public.public_tracking_log_event_v1(
        'request',
        v_ip_hash,
        NULL,
        'invalid_request',
        v_session.organization_id,
        v_session.client_id,
        v_session.shipment_id,
        v_session.id
      );
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
    END IF;

    v_message_body := COALESCE(v_notes, 'Public tracking request: location change submitted');
  ELSE
    PERFORM public.public_tracking_log_event_v1(
      'request',
      v_ip_hash,
      NULL,
      'invalid_request',
      v_session.organization_id,
      v_session.client_id,
      v_session.shipment_id,
      v_session.id
    );
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
  END IF;

  v_metadata := jsonb_strip_nulls(jsonb_build_object(
    'source', 'public_tracking',
    'request_type', v_request_type,
    'session_id', v_session.id,
    'tracking_number', v_session.tracking_number,
    'client_reference_number', NULLIF(btrim(v_session.client_reference_number), ''),
    'carrier_reference_number', NULLIF(btrim(v_session.carrier_reference_number), ''),
    'requested_date', v_requested_date,
    'address_text', v_address_text,
    'short_national_address', v_short_national_address,
    'map_pin', CASE
      WHEN v_lat IS NOT NULL AND v_lng IS NOT NULL THEN jsonb_build_object('lat', v_lat, 'lng', v_lng)
      ELSE NULL
    END,
    'notes', v_notes
  ));

  v_idempotency_key := encode(
    digest(
      v_session.id::TEXT || ':' || v_request_type || ':' || COALESCE(v_metadata::TEXT, ''),
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
      v_metadata,
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
    SELECT sc.id, sc.version
      INTO v_case_id, v_case_version
      FROM public.support_cases sc
     WHERE sc.organization_id = v_session.organization_id
       AND sc.idempotency_key = v_idempotency_key
     LIMIT 1;
  ELSE
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
      'opened',
      NULL,
      'open',
      'public_shipment_tracking',
      v_metadata,
      v_idempotency_key,
      COALESCE(v_case_version, 1),
      workflow_now()
    );

    INSERT INTO public.support_messages (
      support_case_id,
      organization_id,
      direction,
      channel,
      actor_system,
      body,
      metadata,
      created_at
    )
    VALUES (
      v_case_id,
      v_session.organization_id,
      'inbound',
      'in_app',
      'public_shipment_tracking',
      v_message_body,
      v_metadata,
      workflow_now()
    );
  END IF;

  PERFORM public.public_tracking_log_event_v1(
    'request',
    v_ip_hash,
    NULL,
    CASE WHEN v_inserted THEN 'submitted' ELSE 'deduped' END,
    v_session.organization_id,
    v_session.client_id,
    v_session.shipment_id,
    v_session.id,
    jsonb_build_object('support_case_id', v_case_id, 'request_type', v_request_type)
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'submitted', TRUE,
    'deduped', NOT v_inserted,
    'support_case_id', v_case_id,
    'request_type', v_request_type
  );
END;
$function$;

SELECT pg_advisory_unlock(hashtext('202603061350_public_tracking_support_case_conflict_fix_v1'));
COMMIT;

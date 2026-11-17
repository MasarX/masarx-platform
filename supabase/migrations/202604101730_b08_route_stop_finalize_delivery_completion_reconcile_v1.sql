-- Migration: Route stop finalize delivery completion reconcile v1
-- Purpose:
--   - Preserve alternate proof metadata (OTP / identity confirmation) when the
--     COD closeout wrapper rewrites canonical delivery_completion payloads.
--   - Keep shipment_actions, shipments, and route_stops aligned on the same
--     merged delivery_completion contract.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604101730_b08_route_stop_finalize_delivery_completion_reconcile_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_route_stop_finalize_v8(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload JSONB := COALESCE(v_ctx->'payload', '{}'::jsonb);
  v_task_event_payload JSONB := COALESCE(v_payload->'task_event_payload', '{}'::jsonb);
  v_route_stop_id UUID := NULL;
  v_task_event_id UUID := NULL;
  v_stop RECORD;
  v_payment_collection JSONB := NULL;
  v_delivered_box_ids JSONB := NULL;
  v_delivered_box_numbers JSONB := NULL;
  v_otp_confirmed BOOLEAN := FALSE;
  v_otp_last4 TEXT := NULL;
  v_identity_kind TEXT := NULL;
  v_identity_last4 TEXT := NULL;
  v_proof_patch JSONB := '{}'::jsonb;
  v_shipment_action_id UUID := NULL;
  v_delivery_completion_patch JSONB := '{}'::jsonb;
  v_delivery_completion JSONB := '{}'::jsonb;
  v_resp public.workflow_handler_response;
BEGIN
  IF jsonb_typeof(v_task_event_payload->'payment_collection') = 'object' THEN
    v_payment_collection := v_task_event_payload->'payment_collection';
  ELSIF jsonb_typeof(v_task_event_payload #> '{delivery_completion,payment_collection}') = 'object' THEN
    v_payment_collection := v_task_event_payload #> '{delivery_completion,payment_collection}';
  END IF;

  IF jsonb_typeof(v_task_event_payload #> '{delivery_completion,delivered_box_ids}') = 'array' THEN
    v_delivered_box_ids := v_task_event_payload #> '{delivery_completion,delivered_box_ids}';
  ELSIF jsonb_typeof(v_task_event_payload->'delivered_box_ids') = 'array' THEN
    v_delivered_box_ids := v_task_event_payload->'delivered_box_ids';
  ELSIF jsonb_typeof(v_task_event_payload #> '{pod,delivered_box_ids}') = 'array' THEN
    v_delivered_box_ids := v_task_event_payload #> '{pod,delivered_box_ids}';
  END IF;

  IF jsonb_typeof(v_task_event_payload #> '{delivery_completion,delivered_box_numbers}') = 'array' THEN
    v_delivered_box_numbers := v_task_event_payload #> '{delivery_completion,delivered_box_numbers}';
  ELSIF jsonb_typeof(v_task_event_payload->'delivered_box_numbers') = 'array' THEN
    v_delivered_box_numbers := v_task_event_payload->'delivered_box_numbers';
  ELSIF jsonb_typeof(v_task_event_payload #> '{pod,delivered_box_numbers}') = 'array' THEN
    v_delivered_box_numbers := v_task_event_payload #> '{pod,delivered_box_numbers}';
  END IF;

  v_otp_confirmed := COALESCE(
    (v_task_event_payload->>'otp_confirmed')::boolean,
    (v_task_event_payload #>> '{pod,otp_confirmed}')::boolean,
    FALSE
  );
  v_otp_last4 := upper(
    NULLIF(
      regexp_replace(
        COALESCE(
          v_task_event_payload->>'otp_last4',
          v_task_event_payload #>> '{pod,otp_last4}',
          ''
        ),
        '[^A-Za-z0-9]',
        '',
        'g'
      ),
      ''
    )
  );
  IF v_otp_last4 IS NOT NULL THEN
    v_otp_last4 := right(v_otp_last4, 4);
  END IF;

  v_identity_kind := lower(
    NULLIF(
      btrim(
        COALESCE(
          v_task_event_payload->>'recipient_identity_kind',
          v_task_event_payload #>> '{pod,recipient_identity_kind}',
          ''
        )
      ),
      ''
    )
  );
  v_identity_last4 := upper(
    NULLIF(
      regexp_replace(
        COALESCE(
          v_task_event_payload->>'recipient_identity_last4',
          v_task_event_payload #>> '{pod,recipient_identity_last4}',
          ''
        ),
        '[^A-Za-z0-9]',
        '',
        'g'
      ),
      ''
    )
  );
  IF v_identity_last4 IS NOT NULL THEN
    v_identity_last4 := right(v_identity_last4, 4);
  END IF;

  v_proof_patch := jsonb_strip_nulls(jsonb_build_object(
    'otp_confirmed', CASE WHEN v_otp_confirmed THEN TRUE ELSE NULL END,
    'otp_last4', v_otp_last4,
    'recipient_identity_kind', v_identity_kind,
    'recipient_identity_last4', v_identity_last4
  ));

  v_resp := workflow_handlers.execute_route_stop_finalize_v7(p_step, p_run, p_operation_result);
  IF COALESCE(v_resp.status, '') <> 'completed' THEN
    RETURN v_resp;
  END IF;

  IF v_payment_collection IS NOT NULL THEN
    v_delivery_completion_patch := v_delivery_completion_patch || jsonb_build_object('payment_collection', v_payment_collection);
  END IF;
  IF v_delivered_box_ids IS NOT NULL THEN
    v_delivery_completion_patch := v_delivery_completion_patch || jsonb_build_object('delivered_box_ids', v_delivered_box_ids);
  END IF;
  IF v_delivered_box_numbers IS NOT NULL THEN
    v_delivery_completion_patch := v_delivery_completion_patch || jsonb_build_object('delivered_box_numbers', v_delivered_box_numbers);
  END IF;
  IF v_proof_patch IS NOT NULL AND v_proof_patch <> '{}'::jsonb THEN
    v_delivery_completion_patch := v_delivery_completion_patch || v_proof_patch;
  END IF;
  IF v_delivery_completion_patch = '{}'::jsonb THEN
    RETURN v_resp;
  END IF;

  v_delivery_completion := COALESCE(v_resp.operation_result->'delivery_completion', '{}'::jsonb);
  IF jsonb_typeof(v_delivery_completion) <> 'object' THEN
    v_delivery_completion := '{}'::jsonb;
  END IF;
  v_delivery_completion := v_delivery_completion || v_delivery_completion_patch;

  v_resp.operation_result := jsonb_set(
    COALESCE(v_resp.operation_result, '{}'::jsonb),
    '{delivery_completion}',
    v_delivery_completion,
    TRUE
  );

  BEGIN
    v_route_stop_id := NULLIF(v_ctx->>'resource_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_stop_id := NULL;
  END;
  BEGIN
    v_task_event_id := NULLIF(v_task_event_payload->>'task_event_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_task_event_id := NULL;
  END;

  IF v_route_stop_id IS NULL THEN
    RETURN v_resp;
  END IF;

  SELECT rs.organization_id, rs.client_id, rs.shipment_id
    INTO v_stop
    FROM public.route_stops rs
   WHERE rs.id = v_route_stop_id
   LIMIT 1;

  IF v_stop.shipment_id IS NULL THEN
    RETURN v_resp;
  END IF;

  SELECT sa.id
    INTO v_shipment_action_id
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_stop.shipment_id
     AND sa.organization_id = v_stop.organization_id
     AND sa.client_id = v_stop.client_id
     AND (
       (v_task_event_id IS NOT NULL AND (sa.action_data->>'task_event_id') = v_task_event_id::text)
       OR (sa.action_data->>'route_stop_id') = v_route_stop_id::text
     )
   ORDER BY
     CASE
       WHEN v_task_event_id IS NOT NULL AND (sa.action_data->>'task_event_id') = v_task_event_id::text THEN 0
       ELSE 1
     END,
     sa.timestamp DESC,
     sa.created_at DESC
   LIMIT 1;

  IF v_shipment_action_id IS NOT NULL THEN
    UPDATE public.shipment_actions sa
       SET action_data = jsonb_set(COALESCE(sa.action_data, '{}'::jsonb), '{delivery_completion}', v_delivery_completion, TRUE)
     WHERE sa.id = v_shipment_action_id;
  END IF;

  UPDATE public.shipments s
     SET metadata = jsonb_set(COALESCE(s.metadata, '{}'::jsonb), '{delivery_completion}', v_delivery_completion, TRUE),
         updated_at = now()
   WHERE s.id = v_stop.shipment_id
     AND s.client_id = v_stop.client_id;

  UPDATE public.route_stops rs
     SET metadata = jsonb_set(COALESCE(rs.metadata, '{}'::jsonb), '{delivery_completion}', v_delivery_completion, TRUE),
         updated_at = now()
   WHERE rs.id = v_route_stop_id;

  RETURN v_resp;
END;
$function$;

ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO public.operation_handlers (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'route_stop_finalize',
  'workflow_handlers',
  'execute_route_stop_finalize_v8',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v8',
  TRUE,
  'Finalize a dispatch route_stop execution through v7 while persisting canonical delivery completion metadata, including COD payment collection and alternate proof OTP/identity fields.',
  'docs/product/guides/handlers-cookbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

ALTER TABLE public.operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

SELECT pg_advisory_unlock(hashtext('202604101730_b08_route_stop_finalize_delivery_completion_reconcile_v1'));

COMMIT;

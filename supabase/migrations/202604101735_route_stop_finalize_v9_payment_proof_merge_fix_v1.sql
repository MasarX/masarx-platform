-- Migration: Route-stop finalize v9 payment/proof merge fix
-- Purpose:
-- - Preserve COD payment_collection closeout from route_stop_finalize_v8.
-- - Restore alternate-proof projection persistence for OTP/identity metadata.
-- - Avoid early-return drift by resolving route_stop/task_event identifiers from
--   both workflow context and the post-v8 operation result.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604101735_route_stop_finalize_v9_payment_proof_merge_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_route_stop_finalize_v9(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_resp public.workflow_handler_response;
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload JSONB := COALESCE(v_ctx->'payload', '{}'::jsonb);
  v_task_event_payload JSONB := '{}'::jsonb;
  v_route_stop_id UUID := NULL;
  v_task_event_id UUID := NULL;
  v_shipment_action_id UUID := NULL;
  v_shipment_id UUID := NULL;
  v_org UUID := NULL;
  v_client_id UUID := NULL;
  v_action_route_stop_id UUID := NULL;
  v_proof_patch JSONB := '{}'::jsonb;
  v_delivery_completion JSONB := '{}'::jsonb;
  v_otp_confirmed BOOLEAN := FALSE;
  v_otp_last4 TEXT := NULL;
  v_identity_kind TEXT := NULL;
  v_identity_last4 TEXT := NULL;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  v_resp := workflow_handlers.execute_route_stop_finalize_v8(p_step, p_run, p_operation_result);
  IF COALESCE(v_resp.status, '') <> 'completed' THEN
    RETURN v_resp;
  END IF;

  v_task_event_payload := COALESCE(
    v_resp.operation_result->'task_event_payload',
    v_payload->'task_event_payload',
    '{}'::jsonb
  );
  IF jsonb_typeof(v_task_event_payload) IS DISTINCT FROM 'object' THEN
    v_task_event_payload := '{}'::jsonb;
  END IF;

  BEGIN
    v_route_stop_id := COALESCE(
      NULLIF(v_ctx->>'resource_id', ''),
      NULLIF(v_resp.operation_result->>'route_stop_id', ''),
      NULLIF(v_resp.operation_result #>> '{delivery_completion,route_stop_id}', ''),
      NULLIF(v_task_event_payload->>'route_stop_id', ''),
      NULLIF(v_task_event_payload #>> '{delivery_completion,route_stop_id}', ''),
      NULLIF(v_task_event_payload #>> '{pod,route_stop_id}', '')
    )::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_stop_id := NULL;
  END;

  BEGIN
    v_task_event_id := COALESCE(
      NULLIF(v_resp.operation_result->>'task_event_id', ''),
      NULLIF(v_resp.operation_result #>> '{task_event_payload,task_event_id}', ''),
      NULLIF(v_task_event_payload->>'task_event_id', ''),
      NULLIF(v_task_event_payload #>> '{delivery_completion,task_event_id}', '')
    )::uuid;
  EXCEPTION
    WHEN others THEN
      v_task_event_id := NULL;
  END;

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

  IF v_proof_patch = '{}'::jsonb THEN
    RETURN v_resp;
  END IF;

  IF v_task_event_id IS NOT NULL THEN
    SELECT
      sa.id,
      sa.shipment_id,
      sa.organization_id,
      sa.client_id,
      CASE
        WHEN COALESCE(sa.action_data->>'route_stop_id', '') ~* '^[0-9a-f-]{36}$'
          THEN (sa.action_data->>'route_stop_id')::uuid
        ELSE NULL
      END AS route_stop_id
      INTO v_shipment_action_id, v_shipment_id, v_org, v_client_id, v_action_route_stop_id
    FROM public.shipment_actions sa
    WHERE (sa.action_data->>'task_event_id') = v_task_event_id::text
    ORDER BY sa.timestamp DESC, sa.created_at DESC
    LIMIT 1;
  END IF;

  IF v_route_stop_id IS NULL THEN
    v_route_stop_id := v_action_route_stop_id;
  END IF;

  IF v_route_stop_id IS NULL AND v_task_event_id IS NOT NULL THEN
    BEGIN
      SELECT t.resource_id
        INTO v_route_stop_id
      FROM public.task_events te
      JOIN public.tasks t
        ON t.id = te.task_id
      WHERE te.id = v_task_event_id
        AND t.resource_type = 'route_stop'
      LIMIT 1;
    EXCEPTION
      WHEN others THEN
        v_route_stop_id := NULL;
    END;
  END IF;

  IF v_shipment_action_id IS NULL AND v_route_stop_id IS NOT NULL THEN
    SELECT
      sa.id,
      sa.shipment_id,
      sa.organization_id,
      sa.client_id
      INTO v_shipment_action_id, v_shipment_id, v_org, v_client_id
    FROM public.shipment_actions sa
    WHERE (sa.action_data->>'route_stop_id') = v_route_stop_id::text
    ORDER BY sa.timestamp DESC, sa.created_at DESC
    LIMIT 1;
  END IF;

  IF v_route_stop_id IS NOT NULL AND (v_shipment_id IS NULL OR v_org IS NULL OR v_client_id IS NULL) THEN
    SELECT
      rs.shipment_id,
      rs.organization_id,
      rs.client_id
      INTO v_shipment_id, v_org, v_client_id
    FROM public.route_stops rs
    WHERE rs.id = v_route_stop_id
    LIMIT 1;
  END IF;

  v_delivery_completion := COALESCE(v_resp.operation_result->'delivery_completion', '{}'::jsonb);
  IF jsonb_typeof(v_delivery_completion) IS DISTINCT FROM 'object' THEN
    v_delivery_completion := '{}'::jsonb;
  END IF;
  v_delivery_completion := v_delivery_completion || v_proof_patch;

  IF v_shipment_action_id IS NOT NULL THEN
    UPDATE public.shipment_actions sa
       SET action_data = jsonb_set(
             COALESCE(sa.action_data, '{}'::jsonb),
             '{delivery_completion}',
             COALESCE(sa.action_data->'delivery_completion', '{}'::jsonb) || v_delivery_completion,
             TRUE
           )
     WHERE sa.id = v_shipment_action_id;
  END IF;

  IF v_shipment_id IS NOT NULL AND v_client_id IS NOT NULL THEN
    UPDATE public.shipments s
       SET metadata = jsonb_set(
             COALESCE(s.metadata, '{}'::jsonb),
             '{delivery_completion}',
             COALESCE(s.metadata->'delivery_completion', '{}'::jsonb) || v_delivery_completion,
             TRUE
           ),
           updated_at = now()
     WHERE s.id = v_shipment_id
       AND s.client_id = v_client_id;
  END IF;

  IF v_route_stop_id IS NOT NULL THEN
    UPDATE public.route_stops rs
       SET metadata = jsonb_set(
             COALESCE(rs.metadata, '{}'::jsonb),
             '{delivery_completion}',
             COALESCE(rs.metadata->'delivery_completion', '{}'::jsonb) || v_delivery_completion,
             TRUE
           ),
           updated_at = now()
     WHERE rs.id = v_route_stop_id;
  END IF;

  v_resp.operation_result := jsonb_set(
    COALESCE(v_resp.operation_result, '{}'::jsonb),
    '{delivery_completion}',
    v_delivery_completion,
    TRUE
  );

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
  'execute_route_stop_finalize_v9',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v9',
  TRUE,
  'Finalize a dispatch route_stop execution through v8 while persisting canonical COD payment_collection plus OTP and recipient identity proof metadata into delivery_completion projections.',
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

DO $do$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id
    INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'dispatch_route_stop_finalize_v1'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.workflow_template_steps
     SET handler_version = 'v9',
         updated_at = now()
   WHERE workflow_template_id = v_template_id
     AND handler_key = 'route_stop_finalize';
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604101735_route_stop_finalize_v9_payment_proof_merge_fix_v1'));
COMMIT;

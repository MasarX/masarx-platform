-- Migration: webhook intake canonical resource response
-- Purpose: keep webhook HTTP response resource ids aligned with terminal backend readback.

CREATE OR REPLACE FUNCTION public.workflow_intake_webhook(p_token text, p_headers jsonb, p_raw_body text, p_payload jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_result JSONB;
  v_followup_run_id UUID := NULL;
  v_source_id UUID := NULL;
  v_policy_row RECORD;
  v_policy_body JSONB := '{}'::jsonb;
  v_launch_mode TEXT := 'in_background';
  v_response_correlation_id TEXT := NULL;
  v_webhook_id UUID := NULL;
  v_organization_id UUID := NULL;
  v_replayed_webhook_id UUID := NULL;
  v_original_workflow_run_id UUID := NULL;
  v_terminal_shipment_id UUID := NULL;
  v_terminal_tracking_number TEXT := NULL;
  v_response_body JSONB := NULL;
BEGIN
  v_result := public.workflow_intake_webhook_core_v1(
    p_token,
    p_headers,
    p_raw_body,
    p_payload
  );

  IF COALESCE(v_result->>'webhook_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_webhook_id := (v_result->>'webhook_id')::UUID;
  END IF;

  IF NULLIF(v_result->>'workflow_run_id', '') IS NULL
     AND COALESCE(v_result->>'ack_outcome', '') = 'ack_replayed'
     AND v_webhook_id IS NOT NULL THEN
    v_replayed_webhook_id := v_webhook_id;

    SELECT wi.workflow_run_id
      INTO v_original_workflow_run_id
      FROM public.webhook_inbox wi
     WHERE wi.id = v_replayed_webhook_id;

    IF v_original_workflow_run_id IS NOT NULL THEN
      v_result := jsonb_set(
        v_result,
        '{workflow_run_id}',
        to_jsonb(v_original_workflow_run_id::TEXT),
        TRUE
      );
    END IF;
  END IF;

  BEGIN
    v_followup_run_id := NULLIF(v_result->>'followup_workflow_run_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_followup_run_id := NULL;
  END;

  IF v_followup_run_id IS NOT NULL THEN
    SELECT id
      INTO v_source_id
      FROM public.get_webhook_source_by_token(p_token)
      LIMIT 1;
  END IF;

  IF v_followup_run_id IS NOT NULL AND v_source_id IS NOT NULL THEN
    BEGIN
      SELECT *
        INTO v_policy_row
        FROM public.resolve_webhook_ingest_policy(p_webhook_source_id := v_source_id)
       LIMIT 1;

      v_policy_body := COALESCE(v_policy_row.policy, '{}'::jsonb);
      v_launch_mode := COALESCE(
        NULLIF(v_policy_body#>>'{workflow,launch_mode}', ''),
        'in_background'
      );

      IF v_launch_mode = 'sync_only' THEN
        IF EXISTS (
          SELECT 1
          FROM public.workflow_run_steps wrs
          WHERE wrs.workflow_run_id = v_followup_run_id
            AND wrs.step_status = 'pending'
            AND COALESCE(wrs.run_at, now()) <= now()
        ) THEN
          PERFORM public.progress_workflow_run(v_followup_run_id);
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM public.workflow_run_steps wrs
          WHERE wrs.workflow_run_id = v_followup_run_id
            AND wrs.step_status = 'pending'
        ) THEN
          PERFORM public.progress_workflow_run(v_followup_run_id);
        END IF;

        v_result := jsonb_set(v_result, '{followup_sync}', to_jsonb(TRUE), TRUE);
      END IF;
    EXCEPTION
      WHEN others THEN
        v_result := jsonb_set(v_result, '{followup_sync_error}', to_jsonb(SQLERRM), TRUE);
    END;
  END IF;

  IF v_webhook_id IS NOT NULL THEN
    SELECT wi.correlation_id, wi.organization_id
      INTO v_response_correlation_id, v_organization_id
      FROM public.webhook_inbox wi
     WHERE wi.id = v_webhook_id;
  END IF;

  v_response_correlation_id := COALESCE(
    NULLIF(v_response_correlation_id, ''),
    NULLIF(v_result->>'correlation_id', ''),
    NULLIF(v_result->'body'->>'correlation_id', ''),
    NULLIF(v_result->'body'->'webhook'->>'correlation_id', '')
  );

  IF v_response_correlation_id IS NOT NULL THEN
    v_result := jsonb_set(v_result, '{correlation_id}', to_jsonb(v_response_correlation_id), TRUE);

    IF jsonb_typeof(v_result->'body') = 'object' THEN
      v_result := jsonb_set(v_result, '{body,correlation_id}', to_jsonb(v_response_correlation_id), TRUE);
    END IF;

    IF jsonb_typeof(v_result#>'{body,webhook}') = 'object' THEN
      v_result := jsonb_set(v_result, '{body,webhook,correlation_id}', to_jsonb(v_response_correlation_id), TRUE);
    END IF;
  END IF;

  IF v_webhook_id IS NOT NULL AND jsonb_typeof(v_result->'body') = 'object' THEN
    SELECT wid.shipment_id, wid.tracking_number
      INTO v_terminal_shipment_id, v_terminal_tracking_number
      FROM public.v_webhook_inbox_directory wid
     WHERE wid.id = v_webhook_id
       AND wid.is_terminal IS TRUE
       AND wid.shipment_id IS NOT NULL
     LIMIT 1;

    IF v_terminal_shipment_id IS NOT NULL THEN
      v_response_body := (v_result->'body') - 'planned_resource';
      v_response_body := jsonb_set(
        v_response_body,
        '{resource}',
        jsonb_strip_nulls(jsonb_build_object(
          'type', 'shipment',
          'id', v_terminal_shipment_id,
          'tracking_number', v_terminal_tracking_number
        )),
        TRUE
      );
      v_result := jsonb_set(v_result, '{body}', v_response_body, TRUE);
    ELSIF jsonb_typeof(v_result#>'{body,resource}') = 'object'
       AND COALESCE(v_result->'body'->>'status', '') IN ('accepted', 'accepted_async') THEN
      v_result := jsonb_set(v_result, '{body,planned_resource}', v_result#>'{body,resource}', TRUE);
      v_result := jsonb_set(v_result, '{body}', (v_result->'body') - 'resource', TRUE);
    END IF;

    UPDATE public.webhook_inbox
       SET ack_body = v_result->'body'
     WHERE id = v_webhook_id
       AND ack_body IS DISTINCT FROM v_result->'body';

    UPDATE public.decision_log
       SET decision_inputs = jsonb_set(COALESCE(decision_inputs, '{}'::jsonb), '{body}', v_result->'body', TRUE)
     WHERE resource_type = 'webhook_inbox'
       AND resource_id = v_webhook_id
       AND decision_category = 'http_response_emitted'
       AND COALESCE(decision_inputs->'body', 'null'::jsonb) IS DISTINCT FROM v_result->'body';
  END IF;

  IF v_webhook_id IS NOT NULL AND v_followup_run_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.decision_log dl
       WHERE dl.resource_type = 'webhook_inbox'
         AND dl.resource_id = v_webhook_id
         AND dl.decision_outcome = 'workflow_enqueued'
         AND COALESCE(dl.decision_inputs->>'followup_workflow_run_id', dl.decision_inputs->>'workflow_run_id') = v_followup_run_id::TEXT
    ) THEN
      PERFORM public.log_decision(
        p_organization_id := v_organization_id,
        p_decision_category := 'webhook_processing',
        p_resource_type := 'webhook_inbox',
        p_resource_id := v_webhook_id,
        p_decision_point := 'workflow_start',
        p_decision_outcome := 'workflow_enqueued',
        p_performed_by_system := 'workflow_intake_webhook',
        p_correlation_id := NULLIF(v_response_correlation_id, '')::UUID,
        p_decision_inputs := jsonb_build_object(
          'workflow_run_id', v_followup_run_id,
          'followup_workflow_run_id', v_followup_run_id,
          'entry_workflow_run_id', NULLIF(v_result->>'workflow_run_id', ''),
          'source', 'workflow_intake_webhook_wrapper'
        ),
        p_decision_reason := NULL
      );
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB)
  IS 'Webhook intake wrapper: returns body.resource only after terminal canonical shipment readback; otherwise exposes planned_resource for async acceptance.';

REVOKE EXECUTE ON FUNCTION public.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) TO edge_webhook_role;
GRANT EXECUTE ON FUNCTION public.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) TO service_role;

-- Console V2 External Intake: sender/client source-binding failures must be
-- visible as terminal webhook inbox rows, not edge-response-only failures.

BEGIN;

SELECT pg_advisory_lock(hashtext('202607051030_webhook_source_binding_failure_readback_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $patch$
DECLARE
  v_def text;
  v_from text := $from$
  IF v_canonical_intent IN ('shipment.create', 'shipments.create') AND v_source.client_id IS NULL THEN
    v_ack_reason := 'webhook source must be bound to shipment sender/client before shipment.create intake';
    RETURN jsonb_build_object(
      'status', v_bad_status,
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_build_object(
        'error', v_ack_reason,
        'source_identifier', v_source.source_identifier
      ),
      'ack_outcome', 'ack_failed',
      'response_outcome', 'response_failed',
      'response_mode', v_ack_mode,
      'response_reason', 'webhook_source_missing_sender_client',
      'canonical_intent', v_canonical_intent
    );
  END IF;
$from$;
  v_to text := $to$
  IF v_canonical_intent IN ('shipment.create', 'shipments.create') AND v_source.client_id IS NULL THEN
    -- webhook_source_missing_sender_client_inbox_readback_v1
    -- Preserve a redacted, terminal inbound request row even when the
    -- shipment-create source binding guard fails. Operators need same-context
    -- request/readback/replay evidence; workflow start and shipment
    -- materialization remain fail-closed.
    v_ack_reason := 'webhook source must be bound to shipment sender/client before shipment.create intake';
    v_event_type := COALESCE(NULLIF(v_intent_resolution->>'event_type', ''), v_event_type, v_canonical_intent);
    v_payload_for_db := COALESCE(v_intent_resolution->'transformed_payload', v_payload, '{}'::jsonb);
    v_idempotency_config := COALESCE(
      v_policy_body->'validation'->'idempotency',
      jsonb_build_object('header', 'Idempotency-Key', 'body_path', 'event.id', 'required', TRUE)
    );
    v_idempotency_required := COALESCE((v_idempotency_config->>'required')::BOOLEAN, TRUE);
    v_idempotency_key := NULLIF(v_headers->>lower(COALESCE(v_idempotency_config->>'header', 'Idempotency-Key')), '');
    IF v_idempotency_key IS NULL THEN
      v_idempotency_key := NULLIF((jsonb_resolve_path(v_payload, COALESCE(v_idempotency_config->>'body_path', 'event.id')))::TEXT, '');
    END IF;
    IF v_idempotency_key IS NOT NULL THEN
      v_idempotency_key := NULLIF(btrim(v_idempotency_key, '" '), '');
    END IF;

    v_validation := v_validation || jsonb_build_object(
      'idempotency', jsonb_build_object(
        'status', CASE
          WHEN v_idempotency_key IS NULL AND v_idempotency_required THEN 'failed'
          WHEN v_idempotency_key IS NULL THEN 'skipped'
          ELSE 'passed'
        END,
        'key', v_idempotency_key
      ),
      'source_binding', jsonb_build_object(
        'status', 'failed',
        'reason', 'webhook_source_missing_sender_client',
        'webhook_source_id', v_source.id,
        'source_identifier', v_source.source_identifier
      )
    );

    IF v_idempotency_key IS NOT NULL THEN
      SELECT webhook_inbox_id,
             ack_status_code AS status_code,
             ack_headers,
             ack_body,
             ack_outcome,
             ack_reason,
             ack_sent_at
        INTO v_existing_ack
        FROM webhook_ack_history
       WHERE webhook_source_id = v_source.id
         AND idempotency_key = v_idempotency_key
       ORDER BY ack_sent_at DESC
       LIMIT 1;

      IF v_existing_ack.ack_outcome IS NOT NULL THEN
        v_webhook_id := v_existing_ack.webhook_inbox_id;
        v_response_outcome := CASE
          WHEN v_existing_ack.ack_outcome = 'ack_failed' THEN 'response_failed'
          ELSE 'response_replayed'
        END;

        PERFORM log_decision(
          p_organization_id := v_organization_id,
          p_decision_category := 'http_response_emitted',
          p_resource_type := 'webhook_inbox',
          p_resource_id := v_webhook_id,
          p_decision_point := v_decision_point,
          p_decision_outcome := 'response_replayed',
          p_performed_by_system := 'workflow_intake_webhook',
          p_correlation_id := v_correlation_id,
          p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'mode', v_ack_mode,
            'status', COALESCE(v_existing_ack.status_code, v_bad_status),
            'headers', COALESCE(v_existing_ack.ack_headers, jsonb_build_object('content-type', 'application/json')),
            'body', COALESCE(v_existing_ack.ack_body, jsonb_build_object()),
            'validation_results', COALESCE(v_validation, '{}'::jsonb),
            'idempotency_key', v_idempotency_key,
            'canonical_intent', v_canonical_intent,
            'webhook_id', v_webhook_id
          )),
          p_decision_reason := COALESCE(v_existing_ack.ack_reason, v_ack_reason)
        );

        RETURN jsonb_build_object(
          'status', COALESCE(v_existing_ack.status_code, v_bad_status),
          'headers', COALESCE(v_existing_ack.ack_headers, jsonb_build_object('content-type', 'application/json')),
          'body', COALESCE(v_existing_ack.ack_body, jsonb_build_object()),
          'ack_outcome', 'ack_replayed',
          'response_outcome', v_response_outcome,
          'response_mode', v_ack_mode,
          'response_reason', COALESCE(v_existing_ack.ack_reason, 'webhook_source_missing_sender_client'),
          'webhook_id', v_webhook_id,
          'workflow_run_id', NULL,
          'followup_workflow_run_id', NULL,
          'canonical_intent', v_canonical_intent
        );
      END IF;
    END IF;

    PERFORM insert_webhook_inbox_record(
      v_webhook_id,
      v_source.id,
      v_source.provider_type,
      COALESCE(v_payload, '{}'::jsonb),
      v_headers,
      'failed',
      v_correlation_id,
      v_idempotency_key
    );

    UPDATE webhook_inbox
       SET transformed_payload = v_payload_for_db,
           event_type = v_event_type,
           processing_status = 'failed',
           processed_at = now(),
           error_message = v_ack_reason,
           organization_id = v_organization_id,
           policy_scope_type = v_policy_scope_type,
           policy_scope_id = v_policy_scope_id,
           policy_settings_id = v_policy_settings_id,
           policy_version = v_policy_version,
           ack_mode = v_ack_mode,
           ack_status_code = v_bad_status,
           ack_headers = jsonb_build_object('content-type', 'application/json'),
           ack_body = jsonb_build_object(
             'error', v_ack_reason,
             'source_identifier', v_source.source_identifier,
             'webhook_id', v_webhook_id,
             'correlation_id', v_correlation_id
           ),
           ack_outcome = 'ack_failed',
           ack_reason = 'webhook_source_missing_sender_client',
           ack_validation = COALESCE(v_validation, '{}'::jsonb),
           updated_at = now()
     WHERE id = v_webhook_id;

    PERFORM log_decision(
      p_organization_id := v_organization_id,
      p_decision_category := 'http_response_emitted',
      p_resource_type := 'webhook_inbox',
      p_resource_id := v_webhook_id,
      p_decision_point := v_decision_point,
      p_decision_outcome := 'response_failed',
      p_performed_by_system := 'workflow_intake_webhook',
      p_correlation_id := v_correlation_id,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'mode', v_ack_mode,
        'status', v_bad_status,
        'headers', jsonb_build_object('content-type', 'application/json'),
        'body', jsonb_build_object(
          'error', v_ack_reason,
          'source_identifier', v_source.source_identifier,
          'webhook_id', v_webhook_id,
          'correlation_id', v_correlation_id
        ),
        'validation_results', v_validation,
        'idempotency_key', v_idempotency_key,
        'canonical_intent', v_canonical_intent,
        'webhook_id', v_webhook_id
      )),
      p_decision_reason := v_ack_reason,
      p_settings_resolution_id := v_policy_settings_id
    );

    RETURN jsonb_build_object(
      'status', v_bad_status,
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_build_object(
        'error', v_ack_reason,
        'source_identifier', v_source.source_identifier,
        'webhook_id', v_webhook_id,
        'correlation_id', v_correlation_id
      ),
      'ack_outcome', 'ack_failed',
      'response_outcome', 'response_failed',
      'response_mode', v_ack_mode,
      'response_reason', 'webhook_source_missing_sender_client',
      'webhook_id', v_webhook_id,
      'workflow_run_id', NULL,
      'followup_workflow_run_id', NULL,
      'canonical_intent', v_canonical_intent
    );
  END IF;
$to$;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 definition not found';
  END IF;

  IF position('webhook_source_missing_sender_client_inbox_readback_v1' IN v_def) > 0 THEN
    RAISE NOTICE 'workflow_intake_webhook_core_v1 already logs missing source-binding webhook inbox readback';
  ELSE
    IF position(v_from IN v_def) = 0 THEN
      RAISE EXCEPTION 'source binding guard marker not found in workflow_intake_webhook_core_v1';
    END IF;
    v_def := replace(v_def, v_from, v_to);
    EXECUTE v_def;
  END IF;
END;
$patch$;

COMMENT ON FUNCTION public.workflow_intake_webhook_core_v1(TEXT, JSONB, TEXT, JSONB)
  IS 'Core webhook intake entrypoint. Shipment-create intake fails closed until the webhook source is sender/client bound, and source-binding failures persist terminal webhook inbox/decision readback for Console replay and audit.';

DO $assert$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
    INTO v_def;

  IF position('webhook_source_missing_sender_client_inbox_readback_v1' IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 missing source-binding inbox readback patch';
  END IF;
END;
$assert$;

SELECT pg_advisory_unlock(hashtext('202607051030_webhook_source_binding_failure_readback_v1'));
COMMIT;

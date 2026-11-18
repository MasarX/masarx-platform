-- Canonical webhook identity: preserve current intake behavior and grants.
-- Replays adopt source-scoped inbox correlation before audit/response emission.
-- External event identity is independent of transport idempotency.

BEGIN;
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.insert_webhook_inbox_record(
    p_id UUID,
    p_webhook_source_id UUID,
    p_provider_type TEXT,
    p_raw_payload JSONB,
    p_headers JSONB,
    p_processing_status TEXT,
    p_correlation_id UUID,
    p_idempotency_key TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_id UUID := COALESCE(p_id, gen_random_uuid());
BEGIN
    -- Set trace context early so any downstream changes within the same transaction
    -- are captured by audit_table_changes even for tables without correlation_id columns.
    IF p_correlation_id IS NOT NULL THEN
      PERFORM set_config('request.correlation_id', p_correlation_id::text, true);
    END IF;

    INSERT INTO webhook_inbox (
        id,
        webhook_source_id,
        provider_type,
        external_id,
        raw_payload,
        headers,
        processing_status,
        correlation_id,
        idempotency_key
    )
    VALUES (
        v_id,
        p_webhook_source_id,
        p_provider_type,
        COALESCE(
          NULLIF(p_raw_payload#>>'{event,id}', ''),
          NULLIF(p_raw_payload->>'external_id', ''),
          NULLIF(p_raw_payload->>'id', '')
        ),
        COALESCE(p_raw_payload, '{}'::jsonb),
        COALESCE(p_headers, '{}'::jsonb),
        COALESCE(p_processing_status, 'pending'),
        p_correlation_id,
        p_idempotency_key
    );

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.workflow_intake_webhook_core_v1(
  p_token TEXT,
  p_headers JSONB,
  p_raw_body TEXT,
  p_payload JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_headers JSONB := normalize_headers(COALESCE(p_headers, '{}'::jsonb));
  v_persisted_headers JSONB := '{}'::jsonb;
  v_payload JSONB := COALESCE(p_payload, NULL);
  v_source RECORD;
  v_policy RECORD;
  v_policy_body JSONB;
  v_mapping JSONB;
  v_validation JSONB := '{}'::jsonb;
  v_hmac_config JSONB;
  v_idempotency_config JSONB;
  v_idempotency_required BOOLEAN := TRUE;
  v_idempotency_key TEXT;
  v_existing_ack RECORD;
  v_webhook_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
  v_processing_status TEXT := 'in_progress';
  v_ack_mode TEXT := 'accepted_async';
  v_ack_status INT := 202;
  v_bad_status INT := 400;
  v_ack_headers JSONB := '{}'::jsonb;
  v_ack_body JSONB;
  v_ack_outcome TEXT := 'ack_sent';
  v_ack_reason TEXT := NULL;
  v_organization_id UUID;
  v_policy_scope_type TEXT;
  v_policy_scope_id UUID;
  v_policy_settings_id UUID;
  v_policy_version INT;
  v_context_patch JSONB := '{}'::jsonb;
  v_template_id UUID;
  v_entry_template_id UUID;
  v_followup_run_id UUID;
  v_workflow_run_id UUID;
  v_payload_for_db JSONB := '{}'::jsonb;
  v_raw_body_json JSONB;
  v_started TIMESTAMPTZ := clock_timestamp();
  v_processing_ms INT := 0;
  v_decision_point TEXT;
  v_planned_shipment_id UUID;
  v_planned_tracking TEXT;
  v_tracking_policy JSONB;
  v_tracking_scope_type TEXT;
  v_tracking_scope_id UUID;
  v_response_outcome TEXT;
  v_intake_settings JSONB;
  v_defaults JSONB;
  v_event_type TEXT;
  v_raw_intent TEXT;
  v_canonical_intent TEXT;
  v_should_plan BOOLEAN := FALSE;
  v_intent_resolution JSONB := '{}'::jsonb;
BEGIN
  IF v_payload IS NULL AND p_raw_body IS NOT NULL THEN
    BEGIN
      v_raw_body_json := p_raw_body::jsonb;
      v_payload := v_raw_body_json;
    EXCEPTION
      WHEN others THEN
        v_payload := NULL;
    END;
  END IF;

  IF v_payload IS NULL THEN
    v_payload := '{}'::jsonb;
  END IF;

  IF p_token IS NULL OR btrim(p_token) = '' THEN
    RETURN jsonb_build_object(
      'correlation_id', v_correlation_id,
      'status', 401,
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_build_object('error', 'Missing Authorization bearer token'),
      'ack_outcome', 'ack_failed',
      'response_outcome', 'response_failed',
      'response_mode', 'accepted_async'
    );
  END IF;

  SELECT * INTO v_source
  FROM get_webhook_source_by_token(p_token)
  LIMIT 1;

  IF v_source.id IS NULL OR v_source.enabled IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'correlation_id', v_correlation_id,
      'status', 401,
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_build_object('error', 'Unauthorized webhook source'),
      'ack_outcome', 'ack_failed',
      'response_outcome', 'response_failed',
      'response_mode', 'accepted_async'
    );
  END IF;

  v_organization_id := v_source.organization_id;

  SELECT * INTO v_policy
  FROM resolve_webhook_ingest_policy(p_webhook_source_id := v_source.id)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'correlation_id', v_correlation_id,
      'status', 500,
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_build_object('error', 'Webhook ingest policy not configured'),
      'ack_outcome', 'ack_failed',
      'response_outcome', 'response_failed',
      'response_mode', 'accepted_async'
    );
  END IF;

  v_policy_body := COALESCE(v_policy.policy, '{}'::jsonb);
  v_policy_scope_type := v_policy.scope_type;
  v_policy_scope_id := v_policy.scope_id;
  v_policy_settings_id := v_policy.settings_id;
  v_policy_version := v_policy.policy_version;
  v_decision_point := COALESCE(v_policy_body#>>'{logging,decision_point}', 'workflow_intake_ack');

  v_intake_settings := resolve_settings('webhook_intake', 'tenant', v_organization_id);
  IF v_intake_settings IS NULL THEN
    v_intake_settings := resolve_settings('webhook_intake', 'global', NULL);
  END IF;
  v_defaults := COALESCE(v_intake_settings->'defaults', '{}'::jsonb);
  v_entry_template_id := NULLIF(v_intake_settings->>'entry_template_id', '')::UUID;
  IF v_entry_template_id IS NULL THEN
    v_entry_template_id := '77770000-0000-0000-0000-000000770001'::UUID;
  END IF;

  v_ack_mode := COALESCE(v_policy_body->'ack'->>'mode', 'accepted_async');
  v_ack_status := COALESCE(
    (CASE WHEN v_ack_mode = 'accepted_async' THEN v_defaults->>'accepted_async_status' ELSE v_defaults->>'synchronous_success_status' END)::INT,
    CASE WHEN v_ack_mode = 'accepted_async' THEN 202 ELSE 200 END
  );
  v_bad_status := COALESCE((v_defaults->>'bad_request_status')::INT, 400);

  v_event_type := COALESCE(
    NULLIF(v_payload#>>'{event,type}', ''),
    NULLIF(v_payload#>>'{event,kind}', ''),
    NULLIF(v_payload->>'type', '')
  );
  v_raw_intent := NULLIF(v_policy_body#>>'{workflow,intent}', '');
  v_intent_resolution := public.resolve_webhook_shipment_intent_v1(v_payload, v_raw_intent, v_event_type);

  v_validation := v_validation || jsonb_build_object(
    'intent', jsonb_strip_nulls(jsonb_build_object(
      'raw', v_raw_intent,
      'received_event_type', v_event_type,
      'canonical', NULLIF(v_intent_resolution->>'canonical_intent', ''),
      'resolution_status', NULLIF(v_intent_resolution->>'status', ''),
      'reason', NULLIF(v_intent_resolution->>'reason', ''),
      'matched_signals', COALESCE(v_intent_resolution->'matched_signals', '[]'::jsonb)
    ))
  );

  IF COALESCE(v_intent_resolution->>'status', '') = 'ambiguous' THEN
    RETURN jsonb_build_object(
      'correlation_id', v_correlation_id,
      'status', v_bad_status,
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_strip_nulls(jsonb_build_object(
        'error', COALESCE(v_intent_resolution->>'error', 'shipment_update_payload_ambiguous'),
        'event_type', COALESCE(v_event_type, 'shipment.updated'),
        'matched_signals', COALESCE(v_intent_resolution->'matched_signals', '[]'::jsonb)
      )),
      'ack_outcome', 'ack_failed',
      'response_outcome', 'response_failed',
      'response_mode', v_ack_mode,
      'response_reason', COALESCE(v_intent_resolution->>'error', 'shipment_update_payload_ambiguous'),
      'canonical_intent', NULL
    );
  END IF;

  v_canonical_intent := NULLIF(v_intent_resolution->>'canonical_intent', '');
  IF v_canonical_intent IS NULL OR btrim(v_canonical_intent) = '' THEN
    v_canonical_intent := 'shipment.create';
  END IF;
  v_event_type := COALESCE(NULLIF(v_intent_resolution->>'event_type', ''), v_event_type, v_canonical_intent);
  v_payload_for_db := COALESCE(v_intent_resolution->'transformed_payload', v_payload, '{}'::jsonb);
  v_policy_body := jsonb_set(v_policy_body, '{workflow,intent}', to_jsonb(v_canonical_intent), TRUE);
  v_should_plan := public.should_reserve_identifiers_for_shipment_intent_v1(v_canonical_intent, v_policy_body);

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
    )
  );

  IF v_idempotency_key IS NULL AND v_idempotency_required THEN
    RETURN jsonb_build_object(
      'correlation_id', v_correlation_id,
      'status', v_bad_status,
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_build_object('error', 'Missing required idempotency key'),
      'ack_outcome', 'ack_failed',
      'response_outcome', 'response_failed',
      'response_mode', v_ack_mode,
      'response_reason', 'missing_required_idempotency_key'
    );
  END IF;

  IF v_idempotency_key IS NOT NULL THEN
    SELECT ah.webhook_inbox_id,
           ah.ack_status_code AS status_code,
           ah.ack_headers,
           ah.ack_body,
           ah.ack_outcome,
           ah.ack_reason,
           ah.ack_sent_at,
           wi.correlation_id
    INTO v_existing_ack
    FROM public.webhook_ack_history ah
    JOIN public.webhook_inbox wi
      ON wi.id = ah.webhook_inbox_id
     AND wi.webhook_source_id = v_source.id
    WHERE ah.webhook_source_id = v_source.id
      AND ah.idempotency_key = v_idempotency_key
    ORDER BY ah.ack_sent_at DESC
    LIMIT 1;

    IF v_existing_ack.ack_outcome IS NOT NULL THEN
      v_webhook_id := v_existing_ack.webhook_inbox_id;
      -- Replay belongs to the source-scoped inbox, never the new HTTP request.
      v_correlation_id := v_existing_ack.correlation_id;
      PERFORM set_config('request.correlation_id', v_correlation_id::TEXT, TRUE);
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
        p_decision_outcome := v_response_outcome,
        p_performed_by_system := 'workflow_intake_webhook',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'replayed', TRUE,
          'mode', v_ack_mode,
          'status', COALESCE(v_existing_ack.status_code, v_ack_status),
          'headers', COALESCE(v_existing_ack.ack_headers, '{}'::jsonb),
          'body', COALESCE(v_existing_ack.ack_body, jsonb_build_object()),
          'validation_results', COALESCE(v_validation, '{}'::jsonb),
          'idempotency_key', v_idempotency_key,
          'canonical_intent', v_canonical_intent
        )),
        p_decision_reason := v_existing_ack.ack_reason
      );

      RETURN jsonb_build_object(
        'correlation_id', v_correlation_id,
        'status', COALESCE(v_existing_ack.status_code, v_ack_status),
        'headers', COALESCE(v_existing_ack.ack_headers, '{}'::jsonb),
        'body', COALESCE(v_existing_ack.ack_body, jsonb_build_object()),
        'ack_outcome', 'ack_replayed',
        'response_outcome', v_response_outcome,
        'response_mode', v_ack_mode,
        'response_reason', v_existing_ack.ack_reason,
        'webhook_id', v_webhook_id,
        'workflow_run_id', NULL,
        'followup_workflow_run_id', NULL,
        'canonical_intent', v_canonical_intent
      );
    END IF;
  END IF;

  v_hmac_config := v_policy_body->'validation'->'hmac';
  IF v_hmac_config ? 'enabled' AND v_hmac_config->>'enabled' = 'true' THEN
    DECLARE
      v_algorithm TEXT := upper(COALESCE(v_hmac_config->>'algorithm', 'HMAC-SHA256'));
      v_signature_header TEXT := lower(COALESCE(v_hmac_config->>'header', 'x-signature'));
      v_signature_encoding TEXT := lower(COALESCE(v_hmac_config->>'signature_encoding', 'hex'));
      v_provided_signature TEXT := v_headers->>v_signature_header;
      v_auth_config_id UUID := NULLIF(v_hmac_config->>'auth_config_id', '')::UUID;
      v_secret TEXT;
      v_computed BYTEA;
      v_expected TEXT;
    BEGIN
      IF v_provided_signature IS NULL THEN
        v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'failed', 'message', format('Missing signature header %s', v_signature_header)));
        v_ack_outcome := 'ack_failed';
        v_ack_reason := format('Missing signature header %s', v_signature_header);
        v_ack_status := GREATEST(v_ack_status, v_bad_status);
      ELSIF v_auth_config_id IS NULL THEN
        v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'failed', 'message', 'Missing auth_config reference for HMAC validation'));
        v_ack_outcome := 'ack_failed';
        v_ack_reason := 'Missing auth_config reference for HMAC validation';
        v_ack_status := GREATEST(v_ack_status, v_bad_status);
      ELSE
        SELECT COALESCE(credentials->>'signing_secret', credentials->>'secret', credentials->>'api_key')
          INTO v_secret
          FROM provider_auth_configs
         WHERE id = v_auth_config_id;
        IF v_secret IS NULL THEN
          v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'failed', 'message', 'Signing secret missing in provider_auth_configs.credentials'));
          v_ack_outcome := 'ack_failed';
          v_ack_reason := 'Signing secret missing';
          v_ack_status := GREATEST(v_ack_status, v_bad_status);
        ELSE
          v_computed := hmac(coalesce(p_raw_body, '')::bytea, v_secret::bytea, CASE WHEN v_algorithm = 'HMAC-SHA512' THEN 'sha512' ELSE 'sha256' END);
          IF v_signature_encoding = 'base64' THEN
            v_expected := encode(v_computed, 'base64');
          ELSE
            v_expected := encode(v_computed, 'hex');
          END IF;
          IF v_expected <> v_provided_signature THEN
            v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'failed', 'message', 'HMAC signature mismatch'));
            v_ack_outcome := 'ack_failed';
            v_ack_reason := 'HMAC signature mismatch';
            v_ack_status := GREATEST(v_ack_status, v_bad_status);
          ELSE
            v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'passed'));
          END IF;
        END IF;
      END IF;
    END;
  END IF;

  v_persisted_headers := public.redact_webhook_persisted_headers_v1(
    v_headers,
    v_policy_body
  );

  PERFORM insert_webhook_inbox_record(
    v_webhook_id,
    v_source.id,
    v_source.provider_type,
    COALESCE(v_payload, '{}'::jsonb),
    v_persisted_headers,
    CASE WHEN v_ack_outcome = 'ack_failed' THEN 'failed' ELSE v_processing_status END,
    v_correlation_id,
    v_idempotency_key
  );
  UPDATE webhook_inbox
     SET transformed_payload = v_payload_for_db,
         event_type = v_event_type,
         processing_status = CASE WHEN v_ack_outcome = 'ack_failed' THEN 'failed' ELSE v_processing_status END
   WHERE id = v_webhook_id;

  IF v_should_plan THEN
    v_tracking_scope_type := CASE WHEN v_source.client_id IS NOT NULL THEN 'client' ELSE 'tenant' END;
    v_tracking_scope_id := COALESCE(v_source.client_id, v_organization_id);
    v_tracking_policy := resolve_settings('tracking_policy', v_tracking_scope_type, v_tracking_scope_id);
    v_planned_shipment_id := gen_random_uuid();
    v_planned_tracking := generate_tracking_number(v_tracking_scope_type, v_tracking_scope_id, v_tracking_policy);
  ELSE
    v_planned_shipment_id := NULL;
    v_planned_tracking := NULL;
  END IF;

  IF v_policy_body->'ack' ? 'response_mapping_id' THEN
    SELECT mapping_config INTO v_mapping
      FROM mapping_configs
     WHERE id = NULLIF(v_policy_body->'ack'->>'response_mapping_id', '')::UUID;
  ELSE
    v_mapping := NULL;
  END IF;

  IF v_mapping ? 'status_code' THEN
    v_ack_status := COALESCE((v_mapping->>'status_code')::INT, v_ack_status);
  END IF;

  IF v_mapping ? 'headers' THEN
    v_ack_headers := jsonb_strip_nulls(COALESCE(v_mapping->'headers', '{}'::jsonb));
  END IF;

  IF v_mapping ? 'body' THEN
    v_ack_body := render_template(
      v_mapping->'body',
      jsonb_build_object(
        'webhook', jsonb_build_object(
          'id', v_webhook_id,
          'correlation_id', v_correlation_id,
          'source_identifier', v_source.source_identifier
        ),
        'payload', v_payload,
        'transformed_payload', v_payload_for_db,
        'headers', v_persisted_headers,
        'policy', v_policy_body,
        'validation', v_validation,
        'resource', CASE
          WHEN v_should_plan THEN jsonb_build_object(
            'type', 'shipment',
            'id', v_planned_shipment_id,
            'tracking_number', v_planned_tracking
          )
          ELSE NULL
        END
      )
    );
  END IF;

  IF v_ack_body IS NULL OR v_ack_body::TEXT = 'null' THEN
    IF v_ack_mode = 'accepted_async' THEN
      v_ack_body := jsonb_strip_nulls(jsonb_build_object(
        'status', 'accepted_async',
        'correlation_id', v_correlation_id,
        'resource', CASE
          WHEN v_should_plan THEN jsonb_build_object('type', 'shipment', 'id', v_planned_shipment_id, 'tracking_number', v_planned_tracking)
          ELSE NULL
        END
      ));
    ELSE
      v_ack_body := jsonb_strip_nulls(jsonb_build_object(
        'status', 'accepted',
        'resource', CASE
          WHEN v_should_plan THEN jsonb_build_object('type', 'shipment', 'id', v_planned_shipment_id, 'tracking_number', v_planned_tracking)
          ELSE NULL
        END
      ));
    END IF;
  END IF;

  IF v_ack_outcome = 'ack_failed' THEN
    v_ack_status := GREATEST(v_ack_status, v_bad_status);
    v_ack_headers := COALESCE(v_ack_headers, '{}'::jsonb) || jsonb_build_object('content-type', 'application/json');
    v_ack_body := jsonb_build_object('error', COALESCE(v_ack_reason, 'Webhook acknowledgement failed'));
  ELSE
    IF v_ack_headers IS NULL THEN
      v_ack_headers := '{}'::jsonb;
    END IF;
    IF NOT (v_ack_headers ? 'content-type') THEN
      v_ack_headers := v_ack_headers || jsonb_build_object('content-type', 'application/json');
    END IF;
  END IF;

  v_response_outcome := CASE
    WHEN v_ack_outcome = 'ack_failed' THEN 'response_failed'
    ELSE 'response_sent'
  END;

  UPDATE webhook_inbox
     SET processing_status = CASE WHEN v_ack_outcome = 'ack_failed' THEN 'failed' ELSE 'in_progress' END,
         organization_id = COALESCE(organization_id, v_organization_id),
         policy_scope_type = v_policy_scope_type,
         policy_scope_id = v_policy_scope_id,
         policy_settings_id = v_policy_settings_id,
         policy_version = v_policy_version,
         updated_at = now()
   WHERE id = v_webhook_id;

  v_template_id := public.resolve_webhook_followup_template_id_v1(v_policy_body, v_canonical_intent);
  IF v_ack_outcome <> 'ack_failed' AND v_entry_template_id IS NOT NULL THEN
    v_context_patch := COALESCE(v_policy_body->'workflow'->'context_patch', '{}'::jsonb);
    v_context_patch := jsonb_strip_nulls(
      COALESCE(v_context_patch, '{}'::jsonb)
      || jsonb_build_object(
        'canonical_intent', v_canonical_intent,
        'reserve_identifiers', v_should_plan,
        'reserve_new_tracking', CASE WHEN v_canonical_intent = 'shipment.swap' THEN v_should_plan ELSE NULL END,
        'planned_shipment_id', v_planned_shipment_id,
        'planned_tracking_number', v_planned_tracking,
        'client_id', v_source.client_id,
        'sender_id', v_source.sender_id,
        'source_identifier', v_source.source_identifier,
        'followup_template_id', v_template_id
      )
    );
    v_context_patch := jsonb_strip_nulls(
      jsonb_build_object(
        'workflow',
        jsonb_build_object('context_patch', v_context_patch)
      ) || v_context_patch
    );

    v_workflow_run_id := start_workflow_run(
      v_entry_template_id,
      jsonb_strip_nulls(
        jsonb_build_object(
          'webhook_id', v_webhook_id,
          'correlation_id', v_correlation_id,
          'organization_id', v_organization_id,
          'payload', v_payload,
          'transformed_payload', v_payload_for_db,
          'headers', v_persisted_headers,
          'policy', v_policy_body
        ) || v_context_patch
      )
    );

    UPDATE webhook_inbox
       SET workflow_run_id = v_workflow_run_id
     WHERE id = v_webhook_id;

    IF v_template_id IS NOT NULL AND v_template_id <> v_entry_template_id THEN
      v_followup_run_id := start_workflow_run(
        v_template_id,
        jsonb_strip_nulls(
          jsonb_build_object(
            'webhook_id', v_webhook_id,
            'correlation_id', v_correlation_id,
            'organization_id', v_organization_id,
            'started_by_run_id', v_workflow_run_id,
            'payload', v_payload,
            'transformed_payload', v_payload_for_db,
            'headers', v_persisted_headers,
            'policy', v_policy_body
          ) || v_context_patch
        )
      );

      UPDATE workflow_runs
         SET metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('started_by_run_id', v_workflow_run_id))
       WHERE id = v_followup_run_id;
    END IF;
  END IF;

  v_ack_body := jsonb_strip_nulls(COALESCE(v_ack_body, '{}'::jsonb) || jsonb_build_object(
    'workflow_run_id', v_workflow_run_id,
    'followup_workflow_run_id', v_followup_run_id
  ));

  PERFORM log_decision(
    p_organization_id := v_organization_id,
    p_decision_category := 'http_response_emitted',
    p_resource_type := 'webhook_inbox',
    p_resource_id := v_webhook_id,
    p_decision_point := v_decision_point,
    p_decision_outcome := v_response_outcome,
    p_performed_by_system := 'workflow_intake_webhook',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'mode', v_ack_mode,
      'status', v_ack_status,
      'headers', v_ack_headers,
      'body', v_ack_body,
      'validation_results', v_validation,
      'idempotency_key', v_idempotency_key,
      'workflow_run_id', v_workflow_run_id,
      'followup_workflow_run_id', v_followup_run_id,
      'canonical_intent', v_canonical_intent
    )),
    p_decision_reason := v_ack_reason
  );

  v_processing_ms := GREATEST(0, (extract(epoch FROM clock_timestamp() - v_started) * 1000)::INT);

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'correlation_id', v_correlation_id,
    'status', v_ack_status,
    'headers', v_ack_headers,
    'body', v_ack_body,
    'ack_outcome', v_ack_outcome,
    'response_outcome', v_response_outcome,
    'response_mode', v_ack_mode,
    'response_reason', v_ack_reason,
    'processing_time_ms', v_processing_ms,
    'webhook_id', v_webhook_id,
    'workflow_run_id', v_workflow_run_id,
    'followup_workflow_run_id', v_followup_run_id,
    'canonical_intent', v_canonical_intent
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.mirror_webhook_hmac_auth_rejection_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_validation JSONB := COALESCE(NEW.decision_inputs#>'{validation_results,hmac}', '{}'::jsonb);
  v_message TEXT := NULLIF(v_validation->>'message', '');
  v_failure_code TEXT;
  v_http_status INTEGER := 401;
  v_inbox public.webhook_inbox%ROWTYPE;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_hmac JSONB := '{}'::jsonb;
  v_auth_config_id UUID;
  v_auth_exists BOOLEAN := FALSE;
  v_auth_expires_at TIMESTAMPTZ;
BEGIN
  IF NEW.resource_type IS DISTINCT FROM 'webhook_inbox'
     OR NEW.decision_category IS DISTINCT FROM 'http_response_emitted'
     OR NEW.decision_inputs->>'replayed' = 'true'
     OR v_validation->>'status' IS DISTINCT FROM 'failed' THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_inbox
    FROM public.webhook_inbox wi
   WHERE wi.id = NEW.resource_id
   LIMIT 1;

  IF v_inbox.id IS NULL THEN
    RAISE EXCEPTION 'HMAC rejection decision % has no canonical webhook inbox row', NEW.id
      USING ERRCODE = '23503';
  END IF;

  -- Replays share the inbox correlation but are excluded explicitly above.
  -- A non-replayed HMAC decision must still match the canonical inbox.
  IF NEW.correlation_id IS DISTINCT FROM v_inbox.correlation_id THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_webhook_ingest_policy(p_webhook_source_id := v_inbox.webhook_source_id)
   LIMIT 1;
  v_policy := COALESCE(v_policy_row.policy, '{}'::jsonb);
  v_hmac := COALESCE(v_policy#>'{validation,hmac}', '{}'::jsonb);

  IF NULLIF(v_hmac->>'auth_config_id', '') IS NOT NULL THEN
    BEGIN
      v_auth_config_id := (v_hmac->>'auth_config_id')::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      v_auth_config_id := NULL;
    END;
  END IF;

  IF v_auth_config_id IS NOT NULL THEN
    SELECT TRUE, pac.expires_at
      INTO v_auth_exists, v_auth_expires_at
      FROM public.provider_auth_configs pac
     WHERE pac.id = v_auth_config_id
     LIMIT 1;
  END IF;

  v_failure_code := CASE
    WHEN v_message ILIKE 'Missing signature header %' THEN 'hmac_signature_missing'
    WHEN v_message = 'Missing auth_config reference for HMAC validation' THEN 'hmac_auth_config_missing'
    WHEN v_message = 'Signing secret missing' OR v_message ILIKE 'Signing secret missing in %' THEN
      CASE
        WHEN v_auth_config_id IS NULL OR COALESCE(v_auth_exists, FALSE) IS FALSE THEN 'hmac_auth_config_missing'
        WHEN v_auth_expires_at IS NOT NULL AND v_auth_expires_at <= clock_timestamp() THEN 'hmac_credential_expired'
        ELSE 'hmac_credential_unavailable'
      END
    WHEN v_message = 'HMAC signature mismatch' THEN 'hmac_signature_mismatch'
    ELSE 'hmac_validation_failed'
  END;

  BEGIN
    v_http_status := COALESCE(NULLIF(NEW.decision_inputs->>'status', '')::INTEGER, 401);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    v_http_status := 401;
  END;
  IF v_http_status < 400 OR v_http_status > 499 THEN
    v_http_status := 401;
  END IF;

  PERFORM public.record_intake_auth_rejection_v1(
    jsonb_strip_nulls(jsonb_build_object(
      'service', 'webhook_receiver',
      'surface', 'webhook_receiver',
      'credential_kind', 'hmac_signature',
      'source_id', v_inbox.webhook_source_id,
      'http_status', v_http_status,
      'failure_code', v_failure_code,
      'failure_message', COALESCE(v_message, 'HMAC validation failed'),
      'method', 'POST',
      'headers', COALESCE(v_inbox.headers, '{}'::jsonb),
      'correlation_id', COALESCE(v_inbox.correlation_id, NEW.correlation_id),
      'request_id', COALESCE(v_inbox.idempotency_key, v_inbox.correlation_id::TEXT),
      'provider_auth_config_id', v_auth_config_id,
      'metadata', jsonb_strip_nulls(jsonb_build_object(
        'edge_stage', 'workflow_intake_webhook_core_v1',
        'auth_surface', 'hmac_signature',
        'webhook_inbox_id', v_inbox.id,
        'hmac_header', NULLIF(v_hmac->>'header', ''),
        'hmac_algorithm', NULLIF(v_hmac->>'algorithm', ''),
        'hmac_signature_encoding', NULLIF(v_hmac->>'signature_encoding', ''),
        'provided_signature_present', COALESCE(v_inbox.headers, '{}'::jsonb) ? lower(COALESCE(NULLIF(v_hmac->>'header', ''), 'x-signature')),
        'validation_results', v_validation
      ))
    ))
  );

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.workflow_intake_webhook_core_v1(TEXT, JSONB, TEXT, JSONB)
  IS 'Canonical intake identity on every outcome and source-scoped replay; preserves raw HMAC validation, redacted persistence, ACK mapping and workflow orchestration.';
COMMENT ON FUNCTION public.insert_webhook_inbox_record(UUID, UUID, TEXT, JSONB, JSONB, TEXT, UUID, TEXT)
  IS 'Canonical inbox insert with event.id/external_id/id precedence and request.correlation_id audit context.';

COMMIT;

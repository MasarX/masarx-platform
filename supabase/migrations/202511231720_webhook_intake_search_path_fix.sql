-- Migration: workflow_intake_webhook search_path fix
-- Purpose: Ensure all referenced functions/tables resolve under public schema

BEGIN;

CREATE OR REPLACE FUNCTION workflow_intake_webhook(
    p_token TEXT,
    p_headers JSONB,
    p_raw_body TEXT,
    p_payload JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
    v_headers JSONB := normalize_headers(COALESCE(p_headers, '{}'::jsonb));
    v_payload JSONB := COALESCE(p_payload, NULL);
    v_source RECORD;
    v_policy RECORD;
    v_policy_body JSONB;
    v_mapping JSONB;
    v_ack JSONB := '{}'::jsonb;
    v_validation JSONB := '{}'::jsonb;
    v_hmac_config JSONB;
    v_idempotency_config JSONB;
    v_idempotency_key TEXT;
    v_existing_ack RECORD;
    v_webhook_id UUID := gen_random_uuid();
    v_correlation_id UUID := gen_random_uuid();
    v_processing_status TEXT := 'in_progress';
    v_ack_mode TEXT := 'accepted_async';
    v_ack_status INT := 202;
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
    v_workflow_run_id UUID;
    v_payload_for_db JSONB;
    v_raw_body_json JSONB;
    v_now TIMESTAMPTZ := now();
    v_started TIMESTAMPTZ := clock_timestamp();
    v_processing_ms INT := 0;
    v_decision_point TEXT;
    v_planned_shipment_id UUID := NULL;
    v_planned_tracking TEXT := NULL;
    v_tracking_policy JSONB;
    v_tracking_scope_type TEXT;
    v_tracking_scope_id UUID;
    v_is_creation BOOLEAN := FALSE;
BEGIN
    -- Body identical to 202511231710 with explicit search_path
    IF v_payload IS NULL AND p_raw_body IS NOT NULL THEN
        BEGIN
            v_raw_body_json := p_raw_body::jsonb;
            v_payload := v_raw_body_json;
        EXCEPTION WHEN others THEN v_payload := NULL; END;
    END IF;
    IF v_payload IS NULL THEN v_payload := '{}'::jsonb; END IF;

    IF p_token IS NULL OR btrim(p_token) = '' THEN
        RETURN jsonb_build_object('status', 401,'headers', jsonb_build_object('content-type', 'application/json'),'body', jsonb_build_object('error', 'Missing Authorization bearer token'),'ack_outcome', 'ack_failed');
    END IF;

    SELECT * INTO v_source FROM get_webhook_source_by_token(p_token) LIMIT 1;
    IF v_source.id IS NULL OR v_source.enabled IS NOT TRUE THEN
        RETURN jsonb_build_object('status', 401,'headers', jsonb_build_object('content-type', 'application/json'),'body', jsonb_build_object('error', 'Unauthorized webhook source'),'ack_outcome', 'ack_failed');
    END IF;
    v_organization_id := v_source.organization_id;

    SELECT * INTO v_policy FROM resolve_webhook_ingest_policy(p_webhook_source_id := v_source.id) LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 500,'headers', jsonb_build_object('content-type', 'application/json'),'body', jsonb_build_object('error', 'Webhook ingest policy not configured'),'ack_outcome', 'ack_failed');
    END IF;

    v_policy_body := COALESCE(v_policy.policy, '{}'::jsonb);
    v_policy_scope_type := v_policy.scope_type;
    v_policy_scope_id := v_policy.scope_id;
    v_policy_settings_id := v_policy.settings_id;
    v_policy_version := v_policy.policy_version;
    v_decision_point := COALESCE(v_policy_body#>>'{logging,decision_point}', 'workflow_intake_ack');

    v_ack_mode := COALESCE(v_policy_body->'ack'->>'mode', 'accepted_async');
    v_ack_status := CASE WHEN v_ack_mode = 'accepted_async' THEN 202 ELSE 200 END;

    -- Persist inbox
    v_payload_for_db := COALESCE(v_payload, '{}'::jsonb);
    PERFORM insert_webhook_inbox_record(
        v_webhook_id, v_source.id, v_source.provider_type, v_payload_for_db, v_headers, v_processing_status, v_correlation_id, v_idempotency_key
    );
    UPDATE webhook_inbox SET transformed_payload = v_payload_for_db WHERE id = v_webhook_id;

    -- Creation intent gating
    v_is_creation := (COALESCE(v_policy_body#>>'{workflow,intent}', '') = 'shipment_create');
    IF v_is_creation THEN
      v_tracking_scope_type := CASE WHEN v_source.client_id IS NOT NULL THEN 'client' ELSE 'tenant' END;
      v_tracking_scope_id := COALESCE(v_source.client_id, v_organization_id);
      v_tracking_policy := resolve_settings('tracking_policy', v_tracking_scope_type, v_tracking_scope_id);
      v_planned_shipment_id := gen_random_uuid();
      v_planned_tracking := generate_tracking_number(v_tracking_scope_type, v_tracking_scope_id, v_tracking_policy);
    END IF;

    -- Mapping and default body
    IF v_policy_body->'ack' ? 'response_mapping_id' THEN
        SELECT mapping_config INTO v_mapping FROM mapping_configs WHERE id = NULLIF(v_policy_body->'ack'->>'response_mapping_id','')::UUID;
    ELSE v_mapping := NULL; END IF;

    IF v_mapping ? 'status_code' THEN v_ack_status := COALESCE((v_mapping->>'status_code')::INT, v_ack_status); END IF;
    IF v_mapping ? 'headers' THEN v_ack_headers := jsonb_strip_nulls(COALESCE(v_mapping->'headers','{}'::jsonb)); END IF;

    IF v_mapping ? 'body' THEN
        v_ack_body := render_template(
            v_mapping->'body',
            jsonb_build_object(
                'webhook', jsonb_build_object('id', v_webhook_id,'correlation_id', v_correlation_id,'source_identifier', v_source.source_identifier),
                'payload', v_payload,
                'headers', v_headers,
                'policy', v_policy_body,
                'validation', v_validation,
                'resource', CASE WHEN v_planned_shipment_id IS NOT NULL THEN jsonb_build_object('type','shipment','id', v_planned_shipment_id,'tracking_number', v_planned_tracking) ELSE NULL END
            )
        );
    END IF;

    IF v_ack_body IS NULL OR v_ack_body::TEXT = 'null' THEN
        IF v_ack_mode = 'accepted_async' THEN
            v_ack_body := jsonb_strip_nulls(jsonb_build_object('status', 'accepted_async','correlation_id', v_correlation_id,'resource', CASE WHEN v_planned_shipment_id IS NOT NULL THEN jsonb_build_object('type','shipment','id', v_planned_shipment_id, 'tracking_number', v_planned_tracking) ELSE NULL END));
        ELSE
            v_ack_body := jsonb_strip_nulls(jsonb_build_object('status', 'accepted','resource', CASE WHEN v_planned_shipment_id IS NOT NULL THEN jsonb_build_object('type','shipment','id', v_planned_shipment_id, 'tracking_number', v_planned_tracking) ELSE NULL END));
        END IF;
    END IF;

    PERFORM log_decision(
        p_organization_id := v_organization_id,
        p_decision_category := 'http_response_emitted',
        p_resource_type := 'webhook_inbox',
        p_resource_id := v_webhook_id,
        p_decision_point := 'intake_ack',
        p_decision_outcome := CASE WHEN v_ack_outcome = 'ack_failed' THEN 'response_failed' ELSE 'response_sent' END,
        p_performed_by_system := 'workflow_intake_webhook',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'mode', v_ack_mode,
            'status', v_ack_status,
            'headers', COALESCE(v_ack_headers, '{}'::jsonb),
            'body', v_ack_body,
            'validation_results', COALESCE(v_validation, '{}'::jsonb),
            'idempotency_key', v_idempotency_key,
            'workflow_run_id', v_workflow_run_id
        )),
        p_decision_reason := v_ack_reason
    );

    v_processing_ms := GREATEST(0, (extract(epoch FROM clock_timestamp() - v_started) * 1000)::INT);
    PERFORM log_decision(
        p_organization_id := v_organization_id,
        p_decision_category := 'webhook_ack',
        p_resource_type := 'webhook_inbox',
        p_resource_id := v_webhook_id,
        p_decision_point := v_decision_point,
        p_decision_outcome := v_ack_outcome,
        p_performed_by_system := 'workflow_intake_webhook',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'ack_status', v_ack_status,'ack_headers', v_ack_headers,'ack_body', v_ack_body,'validation_results', v_validation,'idempotency_key', v_idempotency_key,'processing_time_ms', v_processing_ms,'planned_shipment_id', v_planned_shipment_id,'planned_tracking_number', v_planned_tracking)),
        p_decision_reason := v_ack_reason);

    UPDATE webhook_inbox
       SET processing_status = 'in_progress', organization_id = COALESCE(organization_id, v_organization_id), policy_scope_type = v_policy_scope_type,
           policy_scope_id = v_policy_scope_id, policy_settings_id = v_policy_settings_id, policy_version = v_policy_version, updated_at = now()
     WHERE id = v_webhook_id;

    v_template_id := NULLIF(v_policy_body#>>'{workflow,template_id}', '')::UUID;
    IF v_template_id IS NOT NULL THEN
        v_context_patch := COALESCE(v_policy_body->'workflow'->'context_patch', '{}'::jsonb);
        v_context_patch := jsonb_strip_nulls(COALESCE(v_context_patch, '{}'::jsonb) || jsonb_build_object('planned_shipment_id', v_planned_shipment_id,'planned_tracking_number', v_planned_tracking,'client_id', v_source.client_id,'sender_id', v_source.sender_id,'source_identifier', v_source.source_identifier));
        v_workflow_run_id := start_workflow_run(
            v_template_id,
            jsonb_strip_nulls(jsonb_build_object('webhook_id', v_webhook_id,'correlation_id', v_correlation_id,'organization_id', v_organization_id,'payload', v_payload,'headers', v_headers,'policy', v_policy_body) || v_context_patch)
        );
        UPDATE webhook_inbox SET workflow_run_id = v_workflow_run_id WHERE id = v_webhook_id;
        PERFORM log_decision(
            p_organization_id := v_organization_id,
            p_decision_category := 'webhook_processing',
            p_resource_type := 'webhook_inbox',
            p_resource_id := v_webhook_id,
            p_decision_point := 'workflow_start',
            p_decision_outcome := 'workflow_enqueued',
            p_performed_by_system := 'workflow_intake_webhook',
            p_correlation_id := v_correlation_id,
            p_decision_inputs := jsonb_build_object('workflow_run_id', v_workflow_run_id, 'workflow_template_id', v_template_id),
            p_decision_reason := NULL);
    END IF;

    RETURN jsonb_strip_nulls(jsonb_build_object('status', v_ack_status,'headers', v_ack_headers,'body', v_ack_body,'ack_outcome', v_ack_outcome,'webhook_id', v_webhook_id,'workflow_run_id', v_workflow_run_id));
END;
$$;

COMMENT ON FUNCTION workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB)
    IS 'Single entrypoint for webhooks: resolves policy, records ack, enqueues workflow run. Planned id/tracking only for workflow.intent=shipment_create.';

REVOKE EXECUTE ON FUNCTION workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) TO edge_webhook_role;
GRANT EXECUTE ON FUNCTION workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) TO service_role;

COMMIT;

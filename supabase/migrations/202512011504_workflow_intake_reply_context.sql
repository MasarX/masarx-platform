-- Migration: Pass transformed communication payload through webhook intake for reply handling
-- Date: 2025-12-01

BEGIN;

CREATE OR REPLACE FUNCTION public.workflow_intake_webhook_core(p_token text, p_headers jsonb, p_raw_body text, p_payload jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_headers JSONB := normalize_headers(COALESCE(p_headers, '{}'::jsonb));
    v_payload JSONB := COALESCE(p_payload, NULL);
    v_payload_transformed JSONB := NULL;
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
    v_payload_for_db JSONB;
    v_raw_body_json JSONB;
    v_now TIMESTAMPTZ := now();
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
    v_is_creation BOOLEAN := FALSE;
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
            'status', 500,
            'headers', jsonb_build_object('content-type', 'application/json'),
            'body', jsonb_build_object('error', 'Webhook ingest policy not configured'),
            'ack_outcome', 'ack_failed',
            'response_outcome', 'response_failed',
            'response_mode', 'accepted_async'
        );
    END IF;

    v_policy_body := COALESCE(v_policy.policy, '{}'::jsonb);

    IF (v_policy_body->'ack'->>'mode') = 'synchronous_success' THEN
        v_ack_mode := 'synchronous_success';
    ELSIF (v_policy_body->'ack'->>'mode') = 'accepted_async' THEN
        v_ack_mode := 'accepted_async';
    END IF;
    IF (v_policy_body->'ack'->>'status_code') IS NOT NULL THEN
        v_ack_status := (v_policy_body->'ack'->>'status_code')::INT;
    END IF;
    IF (v_policy_body->'ack'->>'bad_status_code') IS NOT NULL THEN
        v_bad_status := (v_policy_body->'ack'->>'bad_status_code')::INT;
    END IF;

    v_defaults := resolve_webhook_defaults(v_source.id);
    IF v_defaults IS NOT NULL THEN
        v_payload := jsonb_strip_nulls(COALESCE(v_payload, '{}'::jsonb) || COALESCE(v_defaults, '{}'::jsonb));
    END IF;

    IF v_policy_body ? 'hmac' THEN
        v_hmac_config := v_policy_body->'hmac';
        IF v_hmac_config->>'enabled' = 'true' THEN
            DECLARE
                v_header_name TEXT := COALESCE(NULLIF(v_hmac_config->>'header_name', ''), 'x-signature');
                v_signature_encoding TEXT := COALESCE(NULLIF(v_hmac_config->>'encoding', ''), 'hex');
                v_signature TEXT := v_headers->>v_header_name;
                v_algorithm TEXT := COALESCE(NULLIF(v_hmac_config->>'algorithm', ''), 'HMAC-SHA256');
                v_auth_config_id UUID := NULLIF(v_hmac_config->>'auth_config_id', '')::UUID;
                v_secret TEXT := NULL;
                v_computed BYTEA;
                v_provided_signature TEXT := v_signature;
                v_expected TEXT;
            BEGIN
                IF v_auth_config_id IS NOT NULL THEN
                    SELECT credentials->>'shared_secret'
                      INTO v_secret
                      FROM provider_auth_configs
                     WHERE id = v_auth_config_id;
                END IF;
                IF v_secret IS NULL THEN
                    v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status','failed','message','Signing secret missing in provider_auth_configs.credentials'));
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
                        v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status','failed','message','HMAC signature mismatch'));
                        v_ack_outcome := 'ack_failed';
                        v_ack_reason := 'HMAC signature mismatch';
                        v_ack_status := GREATEST(v_ack_status, v_bad_status);
                    ELSE
                        v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status','passed'));
                    END IF;
                END IF;
            END;
        END IF;
    END IF;

    IF v_policy_body ? 'idempotency' THEN
        v_idempotency_config := v_policy_body->'idempotency';
        v_idempotency_key := generate_idempotency_key(v_headers, v_payload, v_idempotency_config);
    END IF;

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
                p_decision_outcome := v_response_outcome,
                p_performed_by_system := 'workflow_intake_webhook',
                p_correlation_id := v_correlation_id,
                p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'mode', v_ack_mode,
                    'status', COALESCE(v_existing_ack.status_code, v_ack_status),
                    'headers', COALESCE(v_existing_ack.ack_headers, '{}'::jsonb),
                    'body', COALESCE(v_existing_ack.ack_body, jsonb_build_object()),
                    'validation_results', COALESCE(v_validation, '{}'::jsonb),
                    'idempotency_key', v_idempotency_key,
                    'workflow_run_id', NULL,
                    'followup_workflow_run_id', NULL
                )),
                p_decision_reason := v_existing_ack.ack_reason
            );

            RETURN jsonb_build_object(
                'status', COALESCE(v_existing_ack.status_code, v_ack_status),
                'headers', COALESCE(v_existing_ack.ack_headers, '{}'::jsonb),
                'body', COALESCE(v_existing_ack.ack_body, jsonb_build_object()),
                'ack_outcome', 'ack_replayed',
                'response_outcome', v_response_outcome,
                'response_mode', v_ack_mode,
                'response_reason', v_existing_ack.ack_reason,
                'webhook_id', v_webhook_id,
                'workflow_run_id', NULL,
                'followup_workflow_run_id', NULL
            );
        END IF;
    END IF;

    -- Apply mapping_config transforms when defined for the source (e.g., communications reply payloads).
    IF v_source.mapping_config_id IS NOT NULL THEN
        v_payload_transformed := public.apply_mapping_config(v_payload, v_source.mapping_config_id);
    END IF;
    v_payload_for_db := COALESCE(v_payload_transformed, v_payload, '{}'::jsonb);

    PERFORM insert_webhook_inbox_record(
        v_webhook_id,
        v_source.id,
        v_source.provider_type,
        v_payload_for_db,
        v_headers,
        v_processing_status,
        v_correlation_id,
        v_idempotency_key
    );
    UPDATE webhook_inbox SET transformed_payload = v_payload_for_db WHERE id = v_webhook_id;

    IF v_source.provider_type = 'communications' AND v_payload_for_db ? 'communication' THEN
        v_context_patch := jsonb_set(
            COALESCE(v_context_patch, '{}'::jsonb),
            '{communication}',
            v_payload_for_db->'communication',
            TRUE
        );
        v_context_patch := jsonb_set(
            COALESCE(v_context_patch, '{}'::jsonb),
            '{transformed_payload}',
            v_payload_for_db,
            TRUE
        );
    END IF;

    v_payload := v_payload_for_db;
    v_payload_for_db := COALESCE(v_payload, '{}'::jsonb);

    IF v_policy_body->'ack' ? 'response_mapping_id' THEN
        SELECT mapping_config INTO v_mapping
          FROM mapping_configs
         WHERE id = NULLIF(v_policy_body->'ack'->>'response_mapping_id','')::UUID;
    ELSE
        v_mapping := NULL;
    END IF;

    IF v_mapping ? 'status_code' THEN
        v_ack_status := COALESCE((v_mapping->>'status_code')::INT, v_ack_status);
    END IF;

    IF v_mapping ? 'headers' THEN
        v_ack_headers := jsonb_strip_nulls(COALESCE(v_mapping->'headers','{}'::jsonb));
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
                'headers', v_headers,
                'policy', v_policy_body,
                'validation', v_validation,
                'resource', CASE
                    WHEN v_is_creation THEN jsonb_build_object(
                        'type','shipment',
                        'id', v_planned_shipment_id,
                        'tracking_number', v_planned_tracking
                    )
                    ELSE NULL
                END
            )
        );
    END IF;

    IF NOT v_is_creation THEN
        v_ack_body := jsonb_strip_nulls(COALESCE(v_ack_body, '{}'::jsonb) - 'resource');
    END IF;

    IF v_ack_body IS NULL OR v_ack_body::TEXT = 'null' THEN
        IF v_ack_mode = 'accepted_async' THEN
            v_ack_body := jsonb_build_object('status', 'accepted_async');
        ELSE
            v_ack_body := jsonb_build_object('status', 'ok');
        END IF;
    END IF;

    -- Persist ack history (existing behavior)
    INSERT INTO webhook_ack_history (
        webhook_inbox_id,
        webhook_source_id,
        ack_mode,
        ack_status_code,
        ack_headers,
        ack_body,
        ack_outcome,
        ack_reason,
        ack_sent_at,
        idempotency_key,
        policy_settings_id,
        policy_scope_type,
        policy_scope_id,
        policy_version
    ) VALUES (
        v_webhook_id,
        v_source.id,
        v_ack_mode,
        v_ack_status,
        v_ack_headers,
        v_ack_body,
        v_ack_outcome,
        v_ack_reason,
        v_now,
        v_idempotency_key,
        v_policy_settings_id,
        v_policy_scope_type,
        v_policy_scope_id,
        v_policy_version
    );

    v_response_outcome := CASE
        WHEN v_ack_outcome = 'ack_failed' THEN 'response_failed'
        ELSE 'response_sent'
    END;

    PERFORM log_decision(
        p_organization_id := v_organization_id,
        p_decision_category := 'http_response_emitted',
        p_resource_type := 'webhook_inbox',
        p_resource_id := v_webhook_id,
        p_decision_point := 'ack_emitted',
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
            'followup_workflow_run_id', v_followup_run_id
        )),
        p_decision_reason := v_ack_reason
    );

    v_processing_ms := EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_started));

    UPDATE webhook_inbox
       SET processing_status = CASE WHEN v_ack_outcome = 'ack_failed' THEN 'failed' ELSE 'processed' END,
           processed_at = now(),
           updated_at = now(),
           headers = v_headers,
           policy_scope_type = v_policy_scope_type,
           policy_scope_id = v_policy_scope_id,
           policy_settings_id = v_policy_settings_id,
           policy_version = v_policy_version
     WHERE id = v_webhook_id;

    RETURN jsonb_build_object(
        'status', v_ack_status,
        'headers', v_ack_headers,
        'body', v_ack_body,
        'ack_outcome', v_ack_outcome,
        'response_outcome', v_response_outcome,
        'response_mode', v_ack_mode,
        'response_reason', v_ack_reason,
        'webhook_id', v_webhook_id,
        'workflow_run_id', v_workflow_run_id,
        'followup_workflow_run_id', v_followup_run_id
    );
END;
$function$;

COMMIT;

-- Migration: Normalize Dialog360 reply mapping to valid JSONPath and preserve raw vs transformed payloads
-- Date: 2025-12-01

BEGIN;

-- Helper: normalize dotted/ordinal paths into JSONPath (e.g., entry.0.changes.0.value -> $.entry[0].changes[0].value)
CREATE OR REPLACE FUNCTION public.normalize_jsonpath(p_path TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_path TEXT := NULLIF(btrim(p_path), '');
    v_parts TEXT[];
    v_part TEXT;
    v_jsonpath TEXT := '$';
BEGIN
    IF v_path IS NULL THEN
        RETURN NULL;
    END IF;

    -- If the caller already provided a JSONPath, trust it.
    IF v_path LIKE '$%' THEN
        RETURN v_path;
    END IF;

    v_parts := string_to_array(v_path, '.');
    FOREACH v_part IN ARRAY v_parts LOOP
        IF v_part IS NULL OR v_part = '' THEN
            CONTINUE;
        ELSIF v_part ~ '^\d+$' THEN
            v_jsonpath := v_jsonpath || '[' || v_part || ']';
        ELSE
            v_jsonpath := v_jsonpath || '.' || v_part;
        END IF;
    END LOOP;

    RETURN v_jsonpath;
END;
$$;

-- Apply mapping_config with JSONPath normalization and nested transforms support.
CREATE OR REPLACE FUNCTION public.apply_mapping_config(
    p_source JSONB,
    p_mapping_config_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public, pg_temp'
AS $function$
DECLARE
    v_config RECORD;
    v_result JSONB := '{}'::JSONB;
    v_target TEXT;
    v_spec JSONB;
    v_field_key TEXT;
    v_path TEXT;
    v_jsonpath TEXT;
    v_field_val JSONB;
    v_object JSONB;
BEGIN
    IF p_source IS NULL OR p_mapping_config_id IS NULL THEN
        RETURN p_source;
    END IF;

    SELECT mapping_config
    INTO v_config
    FROM public.mapping_configs
    WHERE id = p_mapping_config_id;

    IF NOT FOUND OR v_config.mapping_config IS NULL THEN
        RETURN p_source;
    END IF;

    -- Prefer explicit field_mappings when present.
    IF v_config.mapping_config ? 'field_mappings' THEN
        v_result := public.jsonb_extract_fields(
            p_source,
            v_config.mapping_config->'field_mappings'
        );
        RETURN v_result;
    END IF;

    -- Support nested object transforms (e.g., communication.reply payloads).
    IF v_config.mapping_config ? 'transforms' THEN
        v_result := '{}'::jsonb;
        FOR v_target, v_spec IN
            SELECT key, value
            FROM jsonb_each(v_config.mapping_config->'transforms')
        LOOP
            IF jsonb_typeof(v_spec) = 'object' THEN
                v_object := '{}'::jsonb;
                FOR v_field_key, v_path IN
                    SELECT key, value::TEXT FROM jsonb_each_text(v_spec)
                LOOP
                    v_jsonpath := public.normalize_jsonpath(v_path);
                    BEGIN
                        IF v_jsonpath IS NULL THEN
                            v_field_val := NULL;
                        ELSE
                            v_field_val := jsonb_path_query_first(p_source, v_jsonpath::JSONPATH);
                        END IF;
                    EXCEPTION
                        WHEN OTHERS THEN
                            v_field_val := NULL;
                    END;
                    IF v_field_val IS NULL THEN
                        v_field_val := 'null'::jsonb;
                    END IF;
                    v_object := jsonb_set(v_object, ARRAY[v_field_key], v_field_val, TRUE);
                END LOOP;
                v_result := jsonb_set(v_result, ARRAY[v_target], v_object, TRUE);
            END IF;
        END LOOP;
        RETURN v_result;
    END IF;

    RETURN p_source;
END;
$function$;

-- Preserve raw payload while storing mapped/transformed payload for communications webhooks.
CREATE OR REPLACE FUNCTION public.workflow_intake_webhook_core(p_token text, p_headers jsonb, p_raw_body text, p_payload jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_headers JSONB := normalize_headers(COALESCE(p_headers, '{}'::jsonb));
    v_payload JSONB := COALESCE(p_payload, NULL);
    v_payload_raw JSONB := NULL;
    v_payload_transformed JSONB := NULL;
    v_payload_effective JSONB := NULL;
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

    -- Preserve raw payload; store mapped payload in transformed_payload for workflow context.
    v_payload_raw := COALESCE(v_payload, '{}'::jsonb);

    IF v_source.mapping_config_id IS NOT NULL THEN
        v_payload_transformed := public.apply_mapping_config(v_payload_raw, v_source.mapping_config_id);
    END IF;
    v_payload_effective := COALESCE(v_payload_transformed, v_payload_raw, '{}'::jsonb);

    PERFORM insert_webhook_inbox_record(
        v_webhook_id,
        v_source.id,
        v_source.provider_type,
        v_payload_raw,
        v_headers,
        v_processing_status,
        v_correlation_id,
        v_idempotency_key
    );
    UPDATE webhook_inbox SET transformed_payload = v_payload_effective WHERE id = v_webhook_id;

    IF v_source.provider_type = 'communications' AND v_payload_effective ? 'communication' THEN
        v_context_patch := jsonb_set(
            COALESCE(v_context_patch, '{}'::jsonb),
            '{communication}',
            v_payload_effective->'communication',
            TRUE
        );
        v_context_patch := jsonb_set(
            COALESCE(v_context_patch, '{}'::jsonb),
            '{transformed_payload}',
            v_payload_effective,
            TRUE
        );
    END IF;

    v_payload := v_payload_effective;
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

-- Ensure reply handler sees mapped communication payload and does not drop existing transformed payloads.
CREATE OR REPLACE FUNCTION public.process_dialog360_reply()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_source RECORD;
    v_transformed JSONB;
    v_comm JSONB;
BEGIN
    SELECT source_identifier, mapping_config_id
    INTO v_source
    FROM webhook_sources
    WHERE id = NEW.webhook_source_id;

    IF NOT FOUND OR v_source.source_identifier <> 'dialog360_reply' THEN
        RETURN NEW;
    END IF;

    -- Reuse existing transformed payload when present; otherwise derive from raw payload via mapping_config.
    v_transformed := COALESCE(NEW.transformed_payload, public.apply_mapping_config(NEW.raw_payload, v_source.mapping_config_id));
    v_comm := COALESCE(v_transformed->'communication', '{}'::jsonb);

    -- Fallback: derive recipient/message_id/text from Meta payload shape when mapping is absent.
    IF v_comm = '{}'::jsonb THEN
        v_comm := jsonb_build_object(
            'recipient', NEW.raw_payload #>> '{entry,0,changes,0,value,contacts,0,wa_id}',
            'message_id', NEW.raw_payload #>> '{entry,0,changes,0,value,messages,0,id}',
            'reply_text', NEW.raw_payload #>> '{entry,0,changes,0,value,messages,0,text,body}',
            'timestamp', NEW.raw_payload #>> '{entry,0,changes,0,value,messages,0,timestamp}'
        );
    END IF;

    -- Persist transformed payload (including communication object) for observability/troubleshooting.
    v_transformed := jsonb_set(COALESCE(v_transformed, '{}'::jsonb), '{communication}', COALESCE(v_comm, '{}'::jsonb), TRUE);
    UPDATE webhook_inbox
    SET transformed_payload = v_transformed
    WHERE id = NEW.id;

    -- Invoke reply handler with the derived communication payload.
    PERFORM worker_action_mark_communication_reply(
        NEW.id,
        jsonb_build_object('stop_reason', 'reply_received'),
        jsonb_build_object('transformed_payload', v_transformed)
    );

    RETURN NEW;
END;
$$;

-- Normalize Dialog360 mapping_config to valid JSONPath selectors.
UPDATE mapping_configs
SET mapping_config = jsonb_build_object(
    'description', 'Dialog360 WhatsApp reply mapping (FB webhook payload)',
    'external_id_path', '$.entry[0].changes[0].value.messages[0].id',
    'event_type_path', '$.entry[0].changes[0].value.messages[0].type',
    'transforms', jsonb_build_object(
        'communication', jsonb_build_object(
            'recipient', '$.entry[0].changes[0].value.contacts[0].wa_id',
            'correlation_id', '$.entry[0].changes[0].value.messages[0].context.id',
            'message_id', '$.entry[0].changes[0].value.messages[0].id',
            'reply_payload', '$.entry[0].changes[0].value.messages[0].button.payload',
            'reply_text', '$.entry[0].changes[0].value.messages[0].text.body',
            'timestamp', '$.entry[0].changes[0].value.messages[0].timestamp'
        )
    )
)
WHERE mapping_key = 'dialog360_reply::communication.reply';

COMMIT;

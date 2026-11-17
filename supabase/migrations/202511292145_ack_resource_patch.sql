-- Migration: ACK mapping/resource alignment for client B and non-creation responses
-- Purpose: add resource payload to client B mapping and strip resource for non-creation intents.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Update client B ACK mapping to include resource payload when available.
UPDATE mapping_configs
SET mapping_config = jsonb_build_object(
  'status_code', 200,
  'headers', jsonb_build_object(
    'content-type', 'application/json',
    'x-client-ack', 'jarad'
  ),
  'body', jsonb_build_object(
    'status', 'accepted',
    'correlation_id', '{{ webhook.correlation_id }}',
    'tracking_summary', '{{ resource.tracking_number }}',
    'ack_version', 'jarad.v1',
    'resource', jsonb_build_object(
      'id', '{{ resource.id }}',
      'tracking_number', '{{ resource.tracking_number }}',
      'type', 'shipment'
    )
  )
)
WHERE id = '99990000-0000-0000-0000-000000400002'::UUID;

CREATE OR REPLACE FUNCTION public.workflow_intake_webhook_core(p_token text, p_headers jsonb, p_raw_body text, p_payload jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
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
    v_policy_scope_type := v_policy.scope_type;
    v_policy_scope_id := v_policy.scope_id;
    v_policy_settings_id := v_policy.settings_id;
    v_policy_version := v_policy.policy_version;
    v_decision_point := COALESCE(v_policy_body#>>'{logging,decision_point}', 'workflow_intake_ack');
    v_is_creation := (
        COALESCE(NULLIF(v_policy_body#>>'{workflow,intent}', ''), 'shipment_create') = 'shipment_create'
    );

    v_intake_settings := resolve_settings('webhook_intake', 'tenant', v_organization_id);
    IF v_intake_settings IS NULL THEN
        v_intake_settings := resolve_settings('webhook_intake', 'global', NULL);
    END IF;
    v_defaults := COALESCE(v_intake_settings->'defaults', '{}'::jsonb);
    v_entry_template_id := NULLIF(v_intake_settings->>'entry_template_id', '')::UUID;
    -- When no entry template is configured, treat this as a configuration
    -- error and surface the configured error_status (or 599) instead of
    -- silently falling back to a hardcoded template.
    IF v_entry_template_id IS NULL THEN
        v_ack_outcome := 'ack_failed';
        v_ack_reason := 'webhook_intake entry_template_id not configured';
        v_ack_status := COALESCE(
          (v_defaults->>'error_status')::INT,
          599
        );
    END IF;

    v_ack_mode := COALESCE(v_policy_body->'ack'->>'mode', 'accepted_async');
    v_ack_status := COALESCE(
        (CASE WHEN v_ack_mode = 'accepted_async' THEN v_defaults->>'accepted_async_status' ELSE v_defaults->>'synchronous_success_status' END)::INT,
        CASE WHEN v_ack_mode = 'accepted_async' THEN 202 ELSE 200 END
    );
    v_bad_status := COALESCE((v_defaults->>'bad_request_status')::INT, 400);

    v_idempotency_config := v_policy_body->'validation'->'idempotency';
    IF v_idempotency_config IS NOT NULL THEN
        IF NULLIF(v_idempotency_config->>'header', '') IS NOT NULL THEN
            v_idempotency_key := v_headers->>lower(v_idempotency_config->>'header');
        ELSIF NULLIF(v_idempotency_config->>'body_path', '') IS NOT NULL THEN
            v_idempotency_key := (jsonb_resolve_path(v_payload, v_idempotency_config->>'body_path'))::TEXT;
        END IF;

        IF v_idempotency_key IS NOT NULL THEN
            v_idempotency_key := NULLIF(btrim(v_idempotency_key, ' "'), '');
        END IF;

        v_validation := v_validation || jsonb_build_object(
            'idempotency',
            jsonb_build_object(
                'status', CASE WHEN v_idempotency_key IS NULL THEN 'skipped' ELSE 'passed' END,
                'key', v_idempotency_key
            )
        );
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
                v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status','failed','message', format('Missing signature header %s', v_signature_header)));
                v_ack_outcome := 'ack_failed';
                v_ack_reason := format('Missing signature header %s', v_signature_header);
                v_ack_status := GREATEST(v_ack_status, v_bad_status);
            ELSIF v_auth_config_id IS NULL THEN
                v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status','failed','message','Missing auth_config reference for HMAC validation'));
                v_ack_outcome := 'ack_failed';
                v_ack_reason := 'Missing auth_config reference for HMAC validation';
                v_ack_status := GREATEST(v_ack_status, v_bad_status);
            ELSE
                SELECT COALESCE(credentials->>'signing_secret', credentials->>'secret', credentials->>'api_key')
                  INTO v_secret
                  FROM provider_auth_configs
                 WHERE id = v_auth_config_id;
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
            END IF;
        END;
    END IF;

    v_payload_for_db := COALESCE(v_payload, '{}'::jsonb);
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

    IF v_is_creation THEN
        v_tracking_scope_type := CASE WHEN v_source.client_id IS NOT NULL THEN 'client' ELSE 'tenant' END;
        v_tracking_scope_id := COALESCE(v_source.client_id, v_organization_id);
        v_tracking_policy := resolve_settings('tracking_policy', v_tracking_scope_type, v_tracking_scope_id);
        v_planned_shipment_id := gen_random_uuid();
        v_planned_tracking := generate_tracking_number(v_tracking_scope_type, v_tracking_scope_id, v_tracking_policy);
    ELSE
        v_tracking_scope_type := NULL;
        v_tracking_scope_id := NULL;
        v_tracking_policy := NULL;
        v_planned_shipment_id := NULL;
        v_planned_tracking := NULL;
    END IF;

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
            v_ack_body := jsonb_strip_nulls(jsonb_build_object(
                'status', 'accepted_async',
                'correlation_id', v_correlation_id,
                'resource', CASE
                    WHEN v_is_creation THEN jsonb_build_object('type','shipment','id', v_planned_shipment_id, 'tracking_number', v_planned_tracking)
                    ELSE NULL
                END
            ));
        ELSE
            v_ack_body := jsonb_strip_nulls(jsonb_build_object(
                'status', 'accepted',
                'resource', CASE
                    WHEN v_is_creation THEN jsonb_build_object('type','shipment','id', v_planned_shipment_id, 'tracking_number', v_planned_tracking)
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

    v_template_id := NULLIF(v_policy_body#>>'{workflow,template_id}', '')::UUID;
    IF v_entry_template_id IS NOT NULL THEN
    v_context_patch := COALESCE(v_policy_body->'workflow'->'context_patch', '{}'::jsonb);
    v_context_patch := jsonb_strip_nulls(
        COALESCE(v_context_patch, '{}'::jsonb)
        || jsonb_build_object(
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
                    'headers', v_headers,
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
                        'started_by_run_id', v_workflow_run_id
                    ) || v_context_patch
                )
            );

            UPDATE workflow_runs
            SET metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('started_by_run_id', v_workflow_run_id))
            WHERE id = v_followup_run_id;

            PERFORM log_decision(
                p_organization_id := v_organization_id,
                p_decision_category := 'workflow_processing',
                p_resource_type := 'workflow_run',
                p_resource_id := v_followup_run_id,
                p_decision_point := 'followup_start',
                p_decision_outcome := 'workflow_enqueued',
                p_performed_by_system := 'workflow_intake_webhook',
                p_correlation_id := v_correlation_id,
                p_decision_inputs := jsonb_build_object(
                    'started_by_run_id', v_workflow_run_id,
                    'workflow_template_id', v_template_id
                ),
                p_decision_reason := NULL
            );

            PERFORM log_decision(
                p_organization_id := v_organization_id,
                p_decision_category := 'webhook_processing',
                p_resource_type := 'webhook_inbox',
                p_resource_id := v_webhook_id,
                p_decision_point := 'followup_link',
                p_decision_outcome := 'workflow_enqueued',
                p_performed_by_system := 'workflow_intake_webhook',
                p_correlation_id := v_correlation_id,
                p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'workflow_run_id', v_workflow_run_id,
                    'workflow_template_id', v_entry_template_id,
                    'followup_template_id', v_template_id,
                    'followup_workflow_run_id', v_followup_run_id
                )),
                p_decision_reason := NULL
            );
        ELSE
            PERFORM log_decision(
                p_organization_id := v_organization_id,
                p_decision_category := 'webhook_processing',
                p_resource_type := 'webhook_inbox',
                p_resource_id := v_webhook_id,
                p_decision_point := 'workflow_start',
                p_decision_outcome := 'workflow_enqueued',
                p_performed_by_system := 'workflow_intake_webhook',
                p_correlation_id := v_correlation_id,
                p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'workflow_run_id', v_workflow_run_id,
                    'workflow_template_id', v_entry_template_id,
                    'followup_template_id', v_template_id,
                    'followup_workflow_run_id', v_followup_run_id
                )),
                p_decision_reason := NULL
            );
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
            'followup_workflow_run_id', v_followup_run_id
        )),
        p_decision_reason := v_ack_reason
    );

    v_processing_ms := GREATEST(
        0,
        (extract(epoch FROM clock_timestamp() - v_started) * 1000)::INT
    );

    RETURN jsonb_strip_nulls(jsonb_build_object(
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
        'followup_workflow_run_id', v_followup_run_id
    ));
END;
$function$;


COMMIT;

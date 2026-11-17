-- Migration: Update workflow intake to persist workflow_run_id eager
-- Date: 2025-11-22 11:10 UTC

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
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
    v_intake_template_id UUID;
    v_intake_settings JSONB;
    v_headers JSONB := normalize_headers(COALESCE(p_headers, '{}'::jsonb));
    v_payload JSONB := COALESCE(p_payload, NULL);
    v_source RECORD;
    v_policy RECORD;
    v_policy_body JSONB;
    v_validation JSONB := '{}'::jsonb;
    v_hmac_config JSONB;
    v_schema_id TEXT;
    v_idempotency_config JSONB;
    v_idempotency_key TEXT;
    v_existing_response RECORD;
    v_webhook_id UUID := gen_random_uuid();
    v_correlation_id UUID := gen_random_uuid();
    v_response_status INT := 202;
    v_response_headers JSONB := '{}'::jsonb;
    v_response_body JSONB;
    v_response_mode TEXT := 'accepted_async';
    v_response_outcome TEXT := 'response_sent';
    v_response_reason TEXT;
    v_organization_id UUID;
    v_policy_scope_type TEXT;
    v_policy_scope_id UUID;
    v_policy_settings_id UUID;
    v_policy_version INT;
    v_response_mapping_id UUID;
    v_run_context JSONB;
    v_workflow_run_id UUID;
    v_followup_run_id UUID;
    v_policy_workflow JSONB;
    v_followup_template_id UUID;
    v_followup_context JSONB;
    v_progress JSONB;
    v_run_state JSONB;
    v_loop_count INT := 0;
    v_processing_ms INT := 0;
    v_started TIMESTAMPTZ := clock_timestamp();
    v_http_response JSONB := '{}'::jsonb;
    v_payload_for_db JSONB;
    v_should_run_workflow BOOLEAN := TRUE;
    v_ack_mode TEXT;
    v_should_poll BOOLEAN := TRUE;
BEGIN
    IF v_payload IS NULL AND p_raw_body IS NOT NULL THEN
        BEGIN
            v_payload := p_raw_body::JSONB;
        EXCEPTION
            WHEN OTHERS THEN
                v_payload := NULL;
        END;
    END IF;

    IF v_payload IS NULL THEN
        v_payload := '{}'::JSONB;
    END IF;

    IF p_token IS NULL OR btrim(p_token) = '' THEN
        RETURN jsonb_build_object(
            'status', 401,
            'headers', jsonb_build_object('content-type', 'application/json'),
            'body', jsonb_build_object('error', 'Missing Authorization bearer token'),
            'response_outcome', 'response_failed'
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
            'response_outcome', 'response_failed'
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
            'response_outcome', 'response_failed'
        );
    END IF;

    v_policy_body := COALESCE(v_policy.policy, '{}'::jsonb);
    v_policy_scope_type := v_policy.scope_type;
    v_policy_scope_id := v_policy.scope_id;
    v_policy_settings_id := v_policy.settings_id;
    v_policy_version := v_policy.policy_version;
    v_ack_mode := COALESCE(v_policy_body#>>'{ack,mode}', 'accepted_async');

    v_intake_template_id := NULLIF(v_policy_body#>>'{workflow,template_id}', '')::UUID;

    IF v_intake_template_id IS NULL THEN
        v_intake_settings := resolve_settings('webhook_intake', 'tenant', v_organization_id);
        IF v_intake_settings IS NULL THEN
            v_intake_settings := resolve_settings('webhook_intake', 'global', NULL);
        END IF;
        IF v_intake_settings ? 'entry_template_id' THEN
            v_intake_template_id := NULLIF(v_intake_settings->>'entry_template_id', '')::UUID;
        END IF;
    END IF;

    IF v_intake_template_id IS NULL THEN
        PERFORM log_decision(
        p_organization_id := v_organization_id,
        p_decision_category := 'http_response_emitted',
        p_resource_type := 'webhook_inbox',
        p_resource_id := v_webhook_id,
        p_decision_point := COALESCE(v_policy_body#>>'{logging,decision_point}', 'workflow_intake_response'),
        p_decision_outcome := v_response_outcome,
        p_performed_by_system := 'workflow_intake_webhook',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'status', v_response_status,
            'headers', v_response_headers,
            'body', v_response_body,
            'mode', v_response_mode,
            'validation_results', v_validation,
            'idempotency_key', v_idempotency_key,
            'workflow_run_id', v_workflow_run_id,
            'followup_workflow_run_id', v_followup_run_id
        )),
        p_decision_reason := v_response_reason
    );

    RETURN jsonb_strip_nulls(jsonb_build_object(
            'status', 500,
            'headers', jsonb_build_object('content-type', 'application/json'),
            'body', jsonb_build_object('error', 'intake_template_not_configured'),
            'response_mode', 'synchronous_failure',
            'response_outcome', 'response_failed',
            'response_reason', 'intake_template_not_configured'
        ));
    END IF;

    v_response_mode := COALESCE(v_policy_body->'response'->>'mode', v_policy_body->'ack'->>'mode', 'accepted_async');
    IF v_ack_mode = 'accepted_async' THEN
        v_should_poll := FALSE;
    END IF;
    IF v_response_mode = 'accepted_async' THEN
        v_response_status := 202;
    ELSE
        v_response_status := COALESCE((v_policy_body->'response'->>'status_code')::INT, (v_policy_body->'ack'->>'status_code')::INT, 200);
    END IF;
    v_response_headers := jsonb_strip_nulls(COALESCE(v_policy_body->'response'->'default_headers', v_policy_body->'ack'->'default_headers', '{}'::jsonb));

    v_schema_id := NULLIF(COALESCE(v_policy_body#>>'{validation,json_schema_id}', v_policy_body#>>'{ack,validation,json_schema_id}'), '');
    IF v_schema_id IS NOT NULL THEN
        v_validation := v_validation || jsonb_build_object(
            'json_schema',
            jsonb_build_object(
                'status', 'skipped',
                'message', format('Schema %s queued for workflow validation', v_schema_id)
            )
        );
    END IF;

    v_hmac_config := v_policy_body->'validation'->'hmac';
    IF v_hmac_config IS NOT NULL AND COALESCE(v_hmac_config->>'enabled', 'false') = 'true' THEN
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
                v_validation := v_validation || jsonb_build_object(
                    'hmac',
                    jsonb_build_object(
                        'status', 'failed',
                        'message', format('Missing signature header %s', v_signature_header)
                    )
                );
                v_response_outcome := 'response_failed';
                v_response_reason := format('Missing signature header %s', v_signature_header);
                v_response_status := GREATEST(v_response_status, 400);
                v_response_mode := 'synchronous_failure';
                v_response_headers := jsonb_build_object('content-type', 'application/json');
                v_response_body := jsonb_build_object('error', v_response_reason);
                v_should_run_workflow := FALSE;
            ELSIF v_auth_config_id IS NULL THEN
                v_validation := v_validation || jsonb_build_object(
                    'hmac',
                    jsonb_build_object(
                        'status', 'failed',
                        'message', 'Missing auth_config reference for HMAC validation'
                    )
                );
                v_response_outcome := 'response_failed';
                v_response_reason := 'Missing auth_config reference for HMAC validation';
                v_response_status := GREATEST(v_response_status, 400);
                v_response_mode := 'synchronous_failure';
                v_response_headers := jsonb_build_object('content-type', 'application/json');
                v_response_body := jsonb_build_object('error', v_response_reason);
                v_should_run_workflow := FALSE;
            ELSE
                SELECT COALESCE(
                           credentials->>'signing_secret',
                           credentials->>'secret',
                           credentials->>'api_key'
                       )
                INTO v_secret
                FROM provider_auth_configs
                WHERE id = v_auth_config_id;

                IF v_secret IS NULL THEN
                    v_validation := v_validation || jsonb_build_object(
                        'hmac',
                        jsonb_build_object(
                            'status', 'failed',
                            'message', 'Signing secret missing in provider_auth_configs.credentials'
                        )
                    );
                    v_response_outcome := 'response_failed';
                    v_response_reason := 'Signing secret missing';
                    v_response_status := GREATEST(v_response_status, 400);
                    v_response_mode := 'synchronous_failure';
                    v_response_headers := jsonb_build_object('content-type', 'application/json');
                    v_response_body := jsonb_build_object('error', v_response_reason);
                    v_should_run_workflow := FALSE;
                ELSE
                    v_computed := hmac(coalesce(p_raw_body, '')::bytea, v_secret::bytea, CASE
                        WHEN v_algorithm = 'HMAC-SHA512' THEN 'sha512'
                        ELSE 'sha256'
                    END);

                    IF v_signature_encoding = 'base64' THEN
                        v_expected := encode(v_computed, 'base64');
                    ELSE
                        v_expected := encode(v_computed, 'hex');
                    END IF;

                    IF v_expected <> v_provided_signature THEN
                        v_validation := v_validation || jsonb_build_object(
                            'hmac',
                            jsonb_build_object(
                                'status', 'failed',
                                'message', 'HMAC signature mismatch'
                            )
                        );
                        v_response_outcome := 'response_failed';
                        v_response_reason := 'HMAC signature mismatch';
                        v_response_status := GREATEST(v_response_status, 400);
                        v_response_mode := 'synchronous_failure';
                        v_response_headers := jsonb_build_object('content-type', 'application/json');
                        v_response_body := jsonb_build_object('error', v_response_reason);
                        v_should_run_workflow := FALSE;
                    ELSE
                        v_validation := v_validation || jsonb_build_object(
                            'hmac',
                            jsonb_build_object('status', 'passed')
                        );
                    END IF;
                END IF;
            END IF;
        END;
    ELSIF v_hmac_config IS NOT NULL THEN
        v_validation := v_validation || jsonb_build_object(
            'hmac',
            jsonb_build_object('status', 'skipped')
        );
    END IF;

    IF NOT v_should_run_workflow THEN
        v_response_status := GREATEST(v_response_status, 400);
        IF v_response_headers IS NULL OR v_response_headers::TEXT = 'null' THEN
            v_response_headers := jsonb_build_object('content-type', 'application/json');
        END IF;
        IF v_response_body IS NULL OR v_response_body::TEXT = 'null' THEN
            v_response_body := jsonb_build_object('error', COALESCE(v_response_reason, 'Webhook validation failed'));
        END IF;
    END IF;

    v_idempotency_config := v_policy_body->'validation'->'idempotency';
    IF v_should_run_workflow AND v_idempotency_config IS NOT NULL THEN
        IF NULLIF(v_idempotency_config->>'header', '') IS NOT NULL THEN
            v_idempotency_key := v_headers->>lower(v_idempotency_config->>'header');
        ELSIF NULLIF(v_idempotency_config->>'body_path', '') IS NOT NULL THEN
            v_idempotency_key := (jsonb_resolve_path(v_payload, v_idempotency_config->>'body_path'))::TEXT;
        END IF;

        v_validation := v_validation || jsonb_build_object(
            'idempotency',
            jsonb_build_object(
                'status', CASE WHEN v_idempotency_key IS NULL THEN 'skipped' ELSE 'passed' END,
                'key', v_idempotency_key
            )
        );
    END IF;

    IF v_should_run_workflow AND v_idempotency_key IS NOT NULL THEN
        SELECT
            wi.id AS webhook_id,
            wi.workflow_run_id,
            wr.http_status_code,
            wr.http_headers,
            wr.http_body,
            wr.response_mode,
            wr.response_outcome,
            wr.response_reason
        INTO v_existing_response
        FROM webhook_inbox wi
        JOIN webhook_response_latest wr ON wr.webhook_inbox_id = wi.id
        WHERE wi.webhook_source_id = v_source.id
          AND wr.idempotency_key = v_idempotency_key
        ORDER BY wr.response_created_at DESC
        LIMIT 1;

        IF v_existing_response.webhook_id IS NOT NULL THEN
            v_followup_run_id := (
                SELECT id
                FROM workflow_runs
                WHERE metadata->>'started_by_run_id' = v_existing_response.workflow_run_id::TEXT
                ORDER BY created_at DESC
                LIMIT 1
            );

            PERFORM log_decision(
                p_organization_id := v_organization_id,
                p_decision_category := 'http_response_replayed',
                p_resource_type := 'webhook_inbox',
                p_resource_id := v_existing_response.webhook_id,
                p_decision_point := COALESCE(v_policy_body#>>'{logging,decision_point}', 'workflow_intake_response'),
                p_decision_outcome := 'response_replayed',
                p_performed_by_system := 'workflow_intake_webhook',
                p_correlation_id := v_correlation_id,
                p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'status', COALESCE(v_existing_response.http_status_code, 202),
                    'headers', COALESCE(v_existing_response.http_headers, '{}'::jsonb),
                    'body', COALESCE(v_existing_response.http_body, jsonb_build_object('status', 'accepted_async')),
                    'mode', COALESCE(v_existing_response.response_mode, 'accepted_async'),
                    'outcome', COALESCE(v_existing_response.response_outcome, 'response_sent'),
                    'reason', v_existing_response.response_reason,
                    'workflow_run_id', v_existing_response.workflow_run_id,
                    'followup_workflow_run_id', v_followup_run_id,
                    'validation_results', v_validation,
                    'idempotency_key', v_idempotency_key
                )),
                p_decision_reason := v_existing_response.response_reason
            );

            RETURN jsonb_strip_nulls(jsonb_build_object(
                'status', COALESCE(v_existing_response.http_status_code, 202),
                'headers', COALESCE(v_existing_response.http_headers, '{}'::jsonb),
                'body', COALESCE(v_existing_response.http_body, jsonb_build_object('status', 'accepted_async')),
                'response_mode', COALESCE(v_existing_response.response_mode, 'accepted_async'),
                'response_outcome', COALESCE(v_existing_response.response_outcome, 'response_replayed'),
                'response_reason', v_existing_response.response_reason,
                'webhook_id', v_existing_response.webhook_id,
                'workflow_run_id', v_existing_response.workflow_run_id,
                'followup_workflow_run_id', v_followup_run_id,
                'correlation_id', v_correlation_id
            ));
        END IF;
    END IF;

    v_payload_for_db := COALESCE(v_payload, '{}'::jsonb);

    INSERT INTO webhook_inbox (
        id,
        webhook_source_id,
        provider_type,
        raw_payload,
        headers,
        processing_status,
        correlation_id,
        idempotency_key
    )
    VALUES (
        v_webhook_id,
        v_source.id,
        v_source.provider_type,
        v_payload_for_db,
        v_headers,
        CASE WHEN v_should_run_workflow THEN 'in_progress' ELSE 'failed' END,
        v_correlation_id,
        v_idempotency_key
    );

    v_response_mapping_id := NULLIF(v_policy_body->'response'->>'response_mapping_id', v_policy_body->'ack'->>'response_mapping_id')::UUID;

    v_run_context := jsonb_strip_nulls(jsonb_build_object(
        'webhook_id', v_webhook_id,
        'webhook_source_id', v_source.id,
        'source_identifier', v_source.source_identifier,
        'provider_type', v_source.provider_type,
        'correlation_id', v_correlation_id,
        'payload', v_payload,
        'transformed_payload', v_payload_for_db,
        'headers', v_headers,
        'policy', v_policy_body,
        'validation', v_validation,
        'response_mapping_id', v_response_mapping_id,
        'idempotency_key', v_idempotency_key,
        'organization_id', v_organization_id,
        'policy_scope_type', v_policy_scope_type,
        'policy_scope_id', v_policy_scope_id,
        'policy_settings_id', v_policy_settings_id,
        'policy_version', v_policy_version,
        'http_response', jsonb_strip_nulls(jsonb_build_object(
            'status', v_response_status,
            'headers', v_response_headers,
            'mode', v_response_mode,
            'outcome', v_response_outcome,
            'reason', v_response_reason
        )),
        'response_decision_point', COALESCE(v_policy_body#>>'{logging,decision_point}', 'workflow_intake_response')
    ));

    IF v_policy_body ? 'workflow' THEN
        v_run_context := v_run_context || jsonb_build_object('workflow', v_policy_body->'workflow');
    END IF;

    IF NOT v_should_run_workflow THEN
        UPDATE webhook_inbox
        SET processing_status = 'failed',
            processed_at = now(),
            error_message = v_response_reason,
            updated_at = now()
        WHERE id = v_webhook_id;

        PERFORM log_decision(
            p_organization_id := v_organization_id,
            p_decision_category := 'http_response_emitted',
            p_resource_type := 'webhook_inbox',
            p_resource_id := v_webhook_id,
            p_decision_point := COALESCE(v_policy_body#>>'{logging,decision_point}', 'workflow_intake_response'),
            p_decision_outcome := v_response_outcome,
            p_performed_by_system := 'workflow_intake_webhook',
            p_correlation_id := v_correlation_id,
            p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                'status', v_response_status,
                'headers', v_response_headers,
                'body', COALESCE(v_response_body, jsonb_build_object('error', v_response_reason)),
                'mode', COALESCE(v_response_mode, 'synchronous_failure'),
                'outcome', v_response_outcome,
                'reason', v_response_reason,
                'validation_results', v_validation,
                'idempotency_key', v_idempotency_key
            )),
            p_decision_reason := v_response_reason
        );

        RETURN jsonb_strip_nulls(jsonb_build_object(
            'status', v_response_status,
            'headers', v_response_headers,
            'body', COALESCE(v_response_body, jsonb_build_object('error', v_response_reason)),
            'response_mode', COALESCE(v_response_mode, 'synchronous_failure'),
            'response_outcome', v_response_outcome,
            'response_reason', v_response_reason,
            'webhook_id', v_webhook_id,
            'correlation_id', v_correlation_id,
            'validation_results', v_validation
        ));
    END IF;

    v_workflow_run_id := start_workflow_run(v_intake_template_id, v_run_context);

    UPDATE webhook_inbox
    SET workflow_run_id = v_workflow_run_id,
        processing_status = 'in_progress',
        updated_at = now()
    WHERE id = v_webhook_id;


    IF v_should_poll THEN
        LOOP
            EXIT WHEN v_loop_count >= 10;
            v_loop_count := v_loop_count + 1;

            v_progress := progress_workflow_run(v_workflow_run_id);

            IF COALESCE(v_progress->>'status', '') = 'failed' THEN
                v_response_outcome := 'response_failed';
                v_response_reason := COALESCE(v_progress->>'error', 'response_handler_failure');
                v_response_status := GREATEST(v_response_status, 500);
                v_response_headers := jsonb_build_object('content-type', 'application/json');
                v_response_body := jsonb_build_object('error', v_response_reason);
                EXIT;
            END IF;

            SELECT context
            INTO v_run_state
            FROM workflow_runs
            WHERE id = v_workflow_run_id;

            IF v_run_state IS NULL THEN
                EXIT;
            END IF;

            IF COALESCE(v_progress->>'handler_key', '') IN ('dispatch_followup_workflow', 'dispatch_webhook_followup')
               AND COALESCE(v_progress->>'status', '') = 'completed'
               AND v_followup_run_id IS NULL THEN
                SELECT id
                INTO v_followup_run_id
                FROM workflow_runs
                WHERE metadata->>'started_by_run_id' = v_workflow_run_id::TEXT
                ORDER BY created_at DESC
                LIMIT 1;
            END IF;

            v_http_response := COALESCE(v_run_state->'http_response', '{}'::jsonb);

            IF v_http_response ? 'status' THEN
                v_response_status := COALESCE((v_http_response->>'status')::INT, v_response_status);
            END IF;
            IF v_http_response ? 'headers' THEN
                v_response_headers := COALESCE(v_http_response->'headers', v_response_headers);
            END IF;
            IF v_http_response ? 'body' THEN
                v_response_body := COALESCE(v_http_response->'body', v_response_body);
            END IF;
            IF v_http_response ? 'outcome' THEN
                v_response_outcome := COALESCE(NULLIF(v_http_response->>'outcome', ''), v_response_outcome);
            END IF;
            IF v_http_response ? 'reason' THEN
                v_response_reason := COALESCE(NULLIF(v_http_response->>'reason', ''), v_response_reason);
            END IF;
            IF v_http_response ? 'mode' THEN
                v_response_mode := COALESCE(NULLIF(v_http_response->>'mode', ''), v_response_mode);
            END IF;

            EXIT WHEN NOT EXISTS (
                SELECT 1
                FROM workflow_run_steps
                WHERE workflow_run_id = v_workflow_run_id
                  AND step_status = 'pending'
            );
        END LOOP;

        SELECT context
        INTO v_run_state
        FROM workflow_runs
        WHERE id = v_workflow_run_id;

        IF v_run_state IS NOT NULL THEN
            v_http_response := COALESCE(v_run_state->'http_response', v_http_response);
            IF v_http_response ? 'status' THEN
                v_response_status := COALESCE((v_http_response->>'status')::INT, v_response_status);
            END IF;
            IF v_http_response ? 'headers' THEN
                v_response_headers := COALESCE(v_http_response->'headers', v_response_headers);
            END IF;
            IF v_http_response ? 'body' THEN
                v_response_body := COALESCE(v_http_response->'body', v_response_body);
            END IF;
            IF v_http_response ? 'outcome' THEN
                v_response_outcome := COALESCE(NULLIF(v_http_response->>'outcome', ''), v_response_outcome);
            END IF;
            IF v_http_response ? 'reason' THEN
                v_response_reason := COALESCE(NULLIF(v_http_response->>'reason', ''), v_response_reason);
            END IF;
            IF v_http_response ? 'mode' THEN
                v_response_mode := COALESCE(NULLIF(v_http_response->>'mode', ''), v_response_mode);
            END IF;

            v_followup_run_id := COALESCE(
                v_followup_run_id,
                NULLIF(v_run_state->>'followup_workflow_run_id', '')::UUID
            );
        END IF;
    END IF;

    v_processing_ms := GREATEST(
        0,
        (extract(epoch FROM clock_timestamp() - v_started) * 1000)::INT
    );

    IF v_response_body IS NULL OR v_response_body::TEXT = 'null' THEN
        IF v_response_outcome = 'response_failed' THEN
            v_response_body := jsonb_build_object('error', COALESCE(v_response_reason, 'Webhook response failed'));
        ELSIF v_response_mode = 'accepted_async' THEN
            v_response_body := jsonb_strip_nulls(jsonb_build_object(
                'status', 'accepted_async',
                'correlation_id', v_correlation_id
            ));
        ELSE
            v_response_body := jsonb_build_object('status', 'accepted');
        END IF;
    END IF;

    IF NOT v_should_poll THEN
        v_response_status := 202;
        v_response_mode := 'accepted_async';
        v_response_outcome := 'response_sent';
        v_response_reason := NULL;

        UPDATE webhook_inbox
        SET http_status_code = v_response_status,
            http_headers = v_response_headers,
            http_body = v_response_body,
            response_mode = v_response_mode,
            response_outcome = v_response_outcome,
            response_reason = v_response_reason,
            updated_at = now()
        WHERE id = v_webhook_id;

        v_policy_workflow := COALESCE(v_run_context->'workflow', '{}'::jsonb);
        v_followup_template_id := NULLIF(
            v_policy_workflow#>>'{context_patch,followup_template_id}',
            ''
        )::UUID;

        IF v_followup_template_id IS NULL THEN
            v_followup_template_id := NULLIF(v_policy_workflow->>'template_id', '')::UUID;
        END IF;

        IF v_followup_template_id = v_intake_template_id THEN
            v_followup_template_id := NULL;
        END IF;

        IF v_followup_template_id IS NOT NULL THEN
            v_followup_context := jsonb_strip_nulls(jsonb_build_object(
                'webhook_id', v_webhook_id,
                'correlation_id', v_correlation_id,
                'organization_id', v_organization_id,
                'payload', v_payload,
                'headers', v_headers,
                'policy', v_policy_body,
                'validation', v_validation,
                'workflow_run_id', v_workflow_run_id
            ));

            IF v_policy_workflow ? 'context_patch' THEN
                v_followup_context := jsonb_strip_nulls(
                    v_followup_context || COALESCE(v_policy_workflow->'context_patch', '{}'::jsonb)
                );
            END IF;

            v_followup_run_id := start_workflow_run(v_followup_template_id, v_followup_context);

            UPDATE workflow_runs
            SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
                    'started_by_run_id', v_workflow_run_id
                )),
                updated_at = now()
            WHERE id = v_followup_run_id;

            UPDATE workflow_runs
            SET context = COALESCE(context, '{}'::jsonb) || jsonb_build_object(
                'followup_workflow_run_id', v_followup_run_id
            ),
                updated_at = now()
            WHERE id = v_workflow_run_id;

            UPDATE decision_log
            SET decision_inputs = jsonb_set(
                    COALESCE(decision_inputs, '{}'::jsonb),
                    '{followup_workflow_run_id}',
                    to_jsonb(v_followup_run_id::TEXT),
                    TRUE
                )
            WHERE id = (
                SELECT id
                FROM decision_log
                WHERE resource_type = 'webhook_inbox'
                  AND resource_id = v_webhook_id
                  AND decision_category = 'http_response_emitted'
                ORDER BY timestamp DESC
                LIMIT 1
            );

            PERFORM log_decision(
                p_organization_id := v_organization_id,
                p_decision_category := 'webhook_processing',
                p_resource_type := 'webhook_inbox',
                p_resource_id := v_webhook_id,
                p_decision_point := 'workflow_start',
                p_decision_outcome := 'workflow_enqueued',
                p_performed_by_system := 'workflow_intake_webhook',
                p_correlation_id := v_correlation_id,
                p_decision_inputs := jsonb_build_object(
                    'workflow_run_id', v_followup_run_id,
                    'workflow_template_id', v_followup_template_id
                ),
                p_decision_reason := NULL
            );
        END IF;
    END IF;

    RETURN jsonb_strip_nulls(jsonb_build_object(
        'status', v_response_status,
        'headers', v_response_headers,
        'body', v_response_body,
        'response_mode', v_response_mode,
        'response_outcome', v_response_outcome,
        'response_reason', v_response_reason,
        'webhook_id', v_webhook_id,
        'workflow_run_id', v_workflow_run_id,
        'followup_workflow_run_id', v_followup_run_id,
        'correlation_id', v_correlation_id,
        'processing_ms', v_processing_ms
    ));
END;
$function$;

COMMENT ON FUNCTION workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB)
    IS 'Start webhook intake workflow and emit workflow-computed HTTP response with decision logging.';


CREATE OR REPLACE FUNCTION workflow_handlers.dispatch_followup_workflow_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_followup JSONB := COALESCE(v_context->'workflow', '{}'::jsonb);
    v_existing_followup UUID := NULLIF(v_context->>'followup_workflow_run_id', '')::UUID;
    v_template_id UUID := NULLIF(v_followup#>>'{context_patch,followup_template_id}', '')::UUID;
    v_template_context JSONB := COALESCE(v_followup->'context_patch', '{}'::jsonb);
    v_webhook_id UUID := NULLIF(v_context->>'webhook_id', '')::UUID;
    v_organization_id UUID := NULLIF(v_context->>'organization_id', '')::UUID;
    v_correlation_id UUID := NULLIF(v_context->>'correlation_id', '')::UUID;
    v_followup_run_id UUID;
    v_response workflow_handler_response;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    IF v_template_id IS NULL THEN
        v_template_id := NULLIF(v_followup->>'template_id', '')::UUID;
    END IF;

    IF v_template_id IS NOT NULL AND v_template_id = p_run.workflow_template_id THEN
        v_template_id := NULL;
    END IF;

    IF v_template_id IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('workflow_enqueued', FALSE);
        RETURN v_response;
    END IF;

    IF v_existing_followup IS NOT NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'workflow_enqueued', FALSE,
            'skipped', 'followup_already_started',
            'followup_workflow_run_id', v_existing_followup
        );
        RETURN v_response;
    END IF;

    v_followup_run_id := start_workflow_run(
        v_template_id,
        jsonb_strip_nulls(jsonb_build_object(
            'webhook_id', v_webhook_id,
            'correlation_id', v_correlation_id,
            'organization_id', v_organization_id,
            'payload', v_context->'payload',
            'headers', v_context->'headers',
            'policy', v_context->'policy',
            'validation', v_context->'validation',
            'workflow_run_id', p_run.id
        ) || v_template_context)
    );

    UPDATE workflow_runs
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
            'started_by_run_id', p_run.id,
            'started_by_step_id', p_step.workflow_template_step_id
        )),
        updated_at = now()
    WHERE id = v_followup_run_id;

    UPDATE workflow_runs
    SET context = COALESCE(context, '{}'::jsonb) || jsonb_build_object(
        'followup_workflow_run_id', v_followup_run_id
    ),
        updated_at = now()
    WHERE id = p_run.id;

    IF v_webhook_id IS NOT NULL THEN
        UPDATE decision_log
        SET decision_inputs = jsonb_set(
                COALESCE(decision_inputs, '{}'::jsonb),
                '{followup_workflow_run_id}',
                to_jsonb(v_followup_run_id::TEXT),
                TRUE
            )
        WHERE id = (
            SELECT id
            FROM decision_log
            WHERE resource_type = 'webhook_inbox'
              AND resource_id = v_webhook_id
              AND decision_category = 'http_response_emitted'
            ORDER BY timestamp DESC
            LIMIT 1
        );
    END IF;

    IF v_webhook_id IS NOT NULL THEN
        PERFORM log_decision(
            p_organization_id := v_organization_id,
            p_decision_category := 'webhook_processing',
            p_resource_type := 'webhook_inbox',
            p_resource_id := v_webhook_id,
            p_decision_point := 'workflow_start',
            p_decision_outcome := 'workflow_enqueued',
            p_performed_by_system := 'workflow_engine',
            p_correlation_id := v_correlation_id,
            p_decision_inputs := jsonb_build_object(
                'workflow_run_id', v_followup_run_id,
                'workflow_template_id', v_template_id
            ),
            p_decision_reason := NULL
        );
    END IF;

    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
        'workflow_enqueued', TRUE,
        'followup_workflow_run_id', v_followup_run_id,
        'workflow_template_id', v_template_id
    );
    v_response.context_patch := jsonb_build_object(
        'followup_workflow_run_id', v_followup_run_id
    );

    RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.dispatch_followup_workflow_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Start the configured follow-up workflow and record linkage to the intake run.';

COMMIT;

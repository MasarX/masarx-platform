-- Migration: Align workflow_intake_webhook with response history schema
-- Purpose: remove references to dropped webhook_inbox columns and ensure followup run
--          details are logged dynamically.

BEGIN;

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.workflow_intake_webhook(
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

    v_intake_settings := resolve_settings('webhook_intake', 'tenant', v_organization_id);
    IF v_intake_settings IS NULL THEN
        v_intake_settings := resolve_settings('webhook_intake', 'global', NULL);
    END IF;
    IF v_intake_settings ? 'entry_template_id' THEN
        v_intake_template_id := NULLIF(v_intake_settings->>'entry_template_id', '')::UUID;
    END IF;

    IF v_intake_template_id IS NULL THEN
        v_intake_template_id := NULLIF(v_policy_body#>>'{workflow,template_id}', '')::UUID;
    END IF;

    IF v_intake_template_id IS NULL THEN
        PERFORM log_decision(
            p_organization_id := v_organization_id,
            p_decision_category := 'http_response_emitted',
            p_resource_type := 'webhook_inbox',
            p_resource_id := v_webhook_id,
            p_decision_point := COALESCE(v_policy_body#>>'{logging,decision_point}', 'workflow_intake_response'),
            p_decision_outcome := 'response_failed',
            p_performed_by_system := 'workflow_intake_webhook',
            p_correlation_id := v_correlation_id,
            p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                'status', 500,
                'headers', jsonb_build_object('content-type', 'application/json'),
                'body', jsonb_build_object('error', 'Webhook workflow template not configured'),
                'mode', v_response_mode,
                'outcome', 'response_failed',
                'reason', 'workflow_template_missing',
                'workflow_run_id', NULL,
                'followup_workflow_run_id', NULL,
                'validation_results', v_validation,
                'idempotency_key', v_idempotency_key,
                'processing_ms', 0
            )),
            p_decision_reason := 'Webhook workflow template not configured'
        );

        RETURN jsonb_build_object(
            'status', 500,
            'headers', jsonb_build_object('content-type', 'application/json'),
            'body', jsonb_build_object('error', 'Webhook workflow template not configured'),
            'response_outcome', 'response_failed'
        );
    END IF;

    v_response_mapping_id := NULLIF(v_policy_body->'response'->>'response_mapping_id', '')::UUID;

    v_idempotency_config := COALESCE(v_policy_body->'validation'->'idempotency', '{}'::jsonb);
    IF v_idempotency_config ? 'header' THEN
        v_idempotency_key := v_headers->>lower(v_idempotency_config->>'header');
    ELSIF v_idempotency_config ? 'body_path' THEN
        v_idempotency_key := (jsonb_resolve_path(v_payload, v_idempotency_config->>'body_path'))::TEXT;
    END IF;

    IF v_idempotency_key IS NOT NULL THEN
        v_validation := v_validation || jsonb_build_object(
            'idempotency',
            jsonb_build_object('status', 'passed', 'key', v_idempotency_key)
        );
    ELSE
        v_validation := v_validation || jsonb_build_object(
            'idempotency',
            jsonb_build_object('status', 'skipped')
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

            RETURN jsonb_strip_nulls(jsonb_build_object(
                'status', COALESCE(v_existing_response.http_status_code, 202),
                'headers', COALESCE(v_existing_response.http_headers, '{}'::jsonb),
                'body', COALESCE(v_existing_response.http_body, jsonb_build_object('status', 'accepted_async')),
                'response_outcome', COALESCE(v_existing_response.response_outcome, 'response_replayed'),
                'response_reason', v_existing_response.response_reason,
                'response_mode', COALESCE(v_existing_response.response_mode, 'accepted_async'),
                'webhook_id', v_existing_response.webhook_id,
                'workflow_run_id', v_existing_response.workflow_run_id,
                'followup_workflow_run_id', v_followup_run_id,
                'correlation_id', v_correlation_id,
                'processing_ms', 0
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
        idempotency_key,
        policy_scope_type,
        policy_scope_id,
        policy_settings_id,
        policy_version,
        organization_id
    )
    VALUES (
        v_webhook_id,
        v_source.id,
        v_source.provider_type,
        v_payload_for_db,
        v_headers,
        'in_progress',
        v_correlation_id,
        v_idempotency_key,
        v_policy_scope_type,
        v_policy_scope_id,
        v_policy_settings_id,
        v_policy_version,
        v_organization_id
    );

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
        'response', jsonb_strip_nulls(jsonb_build_object(
            'mode', v_ack_mode,
            'mapping_id', v_response_mapping_id
        )),
        'idempotency_key', v_idempotency_key
    ));

    IF v_should_run_workflow THEN
        v_workflow_run_id := start_workflow_run(
            v_intake_template_id,
            v_run_context
        );

        UPDATE webhook_inbox
        SET workflow_run_id = v_workflow_run_id,
            processing_status = 'in_progress',
            updated_at = now()
        WHERE id = v_webhook_id;
    END IF;

    LOOP
        EXIT WHEN NOT v_should_poll;
        EXIT WHEN v_loop_count > 20;
        EXIT WHEN v_workflow_run_id IS NULL;

        v_loop_count := v_loop_count + 1;

        SELECT context, metadata
        INTO v_run_state, v_progress
        FROM workflow_runs
        WHERE id = v_workflow_run_id
        LIMIT 1;

        IF NOT FOUND THEN
            v_should_poll := FALSE;
            EXIT;
        END IF;

        IF v_run_state ? 'http_response' THEN
            v_http_response := v_run_state->'http_response';
            v_response_status := COALESCE((v_http_response->>'status')::INT, v_response_status);
            v_response_headers := COALESCE(v_http_response->'headers', v_response_headers);
            v_response_body := COALESCE(v_http_response->'body', v_response_body);
            v_response_mode := COALESCE(v_http_response->>'mode', v_response_mode);
            v_response_outcome := COALESCE(v_http_response->>'outcome', v_response_outcome);
            v_response_reason := COALESCE(v_http_response->>'reason', v_response_reason);
            v_followup_run_id := COALESCE(
                v_followup_run_id,
                NULLIF(v_http_response->>'followup_workflow_run_id', '')::UUID
            );
            v_should_poll := FALSE;
        ELSE
            PERFORM progress_workflow_run(v_workflow_run_id);
            PERFORM pg_sleep(0.05);
        END IF;
    END LOOP;

    IF v_progress ? 'followup_workflow_run_id' THEN
        v_followup_run_id := COALESCE(
            v_followup_run_id,
            NULLIF(v_progress->>'followup_workflow_run_id', '')::UUID
        );
    END IF;

    IF v_workflow_run_id IS NOT NULL THEN
        IF NOT v_run_state ? 'http_response' THEN
            v_should_poll := FALSE;
            UPDATE webhook_inbox
            SET processing_status = 'in_progress',
                updated_at = now()
            WHERE id = v_webhook_id;
        END IF;
    END IF;

    IF v_response_headers IS NULL OR jsonb_typeof(v_response_headers) <> 'object' THEN
        v_response_headers := jsonb_build_object('content-type', 'application/json');
    ELSIF NOT v_response_headers ? 'content-type' THEN
        v_response_headers := v_response_headers || jsonb_build_object('content-type', 'application/json');
    END IF;

    IF v_run_state ? 'workflow_followup_run_id' THEN
        v_followup_run_id := COALESCE(
            v_followup_run_id,
            NULLIF(v_run_state->>'workflow_followup_run_id', '')::UUID
        );
    END IF;

    v_processing_ms := GREATEST(
        0,
        (EXTRACT(EPOCH FROM clock_timestamp() - v_started) * 1000)::INT
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
        SET updated_at = now()
        WHERE id = v_webhook_id;

        v_policy_workflow := COALESCE(v_run_context->'workflow', '{}'::jsonb);
        v_followup_template_id := NULLIF(v_policy_workflow->>'template_id', '')::UUID;
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

        IF v_followup_template_id IS NOT NULL THEN
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
                    'workflow_template_id', v_followup_template_id,
                    'followup_workflow_run_id', v_followup_run_id
                ),
                p_decision_reason := NULL
            );
        END IF;
    END IF;

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
            'outcome', v_response_outcome,
            'reason', v_response_reason,
            'workflow_run_id', v_workflow_run_id,
            'followup_workflow_run_id', v_followup_run_id,
            'validation_results', v_validation,
            'idempotency_key', v_idempotency_key,
            'processing_ms', v_processing_ms
        )),
        p_decision_reason := v_response_reason
    );

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

COMMIT;


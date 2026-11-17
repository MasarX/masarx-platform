-- Migration: Refactor webhook intake to use generic HTTP response handlers
-- Date: 2025-11-20 18:05 UTC

BEGIN;

-------------------------------------------------------------------------------
-- 1. Update workflow template steps to use generic handler keys
-------------------------------------------------------------------------------

UPDATE workflow_template_steps
SET
    operation_name = 'render_http_response',
    handler_key = 'render_http_response',
    handler_version = 'v1'
WHERE id = '77770000-0000-0000-0000-000000770011';

UPDATE workflow_template_steps
SET
    operation_name = 'persist_http_response',
    handler_key = 'persist_http_response',
    handler_version = 'v1'
WHERE id = '77770000-0000-0000-0000-000000770012';

UPDATE workflow_template_steps
SET
    operation_name = 'dispatch_followup_workflow'
WHERE id = '77770000-0000-0000-0000-000000770013';

-------------------------------------------------------------------------------
-- 2. Recreate workflow_intake_webhook with generic response semantics
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_intake_webhook(
    p_token TEXT,
    p_headers JSONB,
    p_raw_body TEXT,
    p_payload JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_intake_template_id CONSTANT UUID := '77770000-0000-0000-0000-000000770001';
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
    v_existing_inbox RECORD;
    v_existing_response RECORD;
    v_webhook_id UUID := gen_random_uuid();
    v_correlation_id UUID := gen_random_uuid();
    v_response_status INT := 202;
    v_response_headers JSONB := '{}'::jsonb;
    v_response_body JSONB;
    v_response_mode TEXT := 'accepted_async';
    v_response_outcome TEXT := 'ack_sent';
    v_response_reason TEXT;
    v_organization_id UUID;
    v_policy_scope_type TEXT;
    v_policy_scope_id UUID;
    v_policy_settings_id UUID;
    v_policy_version INT;
    v_template_id UUID;
    v_response_mapping_id UUID;
    v_run_context JSONB;
    v_workflow_run_id UUID;
    v_followup_run_id UUID;
    v_progress JSONB;
    v_run_state JSONB;
    v_loop_count INT := 0;
    v_processing_ms INT := 0;
    v_started TIMESTAMPTZ := clock_timestamp();
    v_now TIMESTAMPTZ := now();
    v_http_response JSONB := '{}'::jsonb;
    v_payload_for_db JSONB;
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
            'ack_outcome', 'ack_failed'
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
            'ack_outcome', 'ack_failed'
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
            'ack_outcome', 'ack_failed'
        );
    END IF;

    v_policy_body := COALESCE(v_policy.policy, '{}'::jsonb);
    v_policy_scope_type := v_policy.scope_type;
    v_policy_scope_id := v_policy.scope_id;
    v_policy_settings_id := v_policy.settings_id;
    v_policy_version := v_policy.policy_version;

    v_response_mode := COALESCE(v_policy_body->'ack'->>'mode', 'accepted_async');
    IF v_response_mode = 'accepted_async' THEN
        v_response_status := 202;
    ELSE
        v_response_status := COALESCE((v_policy_body->'ack'->>'status_code')::INT, 200);
    END IF;
    v_response_headers := jsonb_strip_nulls(COALESCE(v_policy_body->'ack'->'default_headers', '{}'::jsonb));

    v_schema_id := NULLIF(v_policy_body#>>'{validation,json_schema_id}', '');
    IF v_schema_id IS NOT NULL THEN
        v_validation := v_validation || jsonb_build_object(
            'json_schema',
            jsonb_build_object(
                'status', 'skipped',
                'message', format('Schema %s queued for workflow validation', v_schema_id)
            )
        );
    END IF;

    v_idempotency_config := v_policy_body->'validation'->'idempotency';
    IF v_idempotency_config IS NOT NULL THEN
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

    IF v_idempotency_key IS NOT NULL THEN
        SELECT
            wi.id AS webhook_id,
            wi.workflow_run_id,
            wrh.http_status_code,
            wrh.http_headers,
            wrh.http_body,
            wrh.response_outcome,
            wrh.response_reason
        INTO v_existing_response
        FROM webhook_response_history wrh
        JOIN webhook_inbox wi ON wi.id = wrh.webhook_inbox_id
        WHERE wi.webhook_source_id = v_source.id
          AND wrh.idempotency_key = v_idempotency_key
        ORDER BY wrh.created_at DESC
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
                'ack_outcome', COALESCE(v_existing_response.response_outcome, 'ack_replayed'),
                'ack_reason', v_existing_response.response_reason,
                'webhook_id', v_existing_response.webhook_id,
                'workflow_run_id', v_existing_response.workflow_run_id,
                'followup_workflow_run_id', v_followup_run_id
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
        'in_progress',
        v_correlation_id,
        v_idempotency_key
    );

    v_response_mapping_id := NULLIF(v_policy_body->'ack'->>'response_mapping_id', '')::UUID;

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
        'ack', jsonb_strip_nulls(jsonb_build_object(
            'mode', v_response_mode,
            'status', v_response_status,
            'header_defaults', v_response_headers,
            'outcome', v_response_outcome,
            'reason', v_response_reason
        )),
        'http_response', jsonb_strip_nulls(jsonb_build_object(
            'status', v_response_status,
            'headers', v_response_headers,
            'mode', v_response_mode
        )),
        'response_decision_point', COALESCE(v_policy_body#>>'{logging,decision_point}', 'workflow_intake_response')
    ));

    IF v_policy_body ? 'workflow' THEN
        v_run_context := v_run_context || jsonb_build_object('workflow', v_policy_body->'workflow');
    END IF;

    v_workflow_run_id := start_workflow_run(v_intake_template_id, v_run_context);

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

        IF COALESCE(v_progress->>'handler_key', '') = 'dispatch_followup_workflow'
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
        v_followup_run_id := COALESCE(
            v_followup_run_id,
            NULLIF(v_run_state->>'followup_workflow_run_id', '')::UUID
        );
    END IF;
    IF NOT (v_http_response ? 'status') THEN
        v_http_response := COALESCE(v_run_state->'ack', '{}'::jsonb);
        IF v_http_response ? 'ack_status' THEN
            v_response_status := COALESCE((v_http_response->>'ack_status')::INT, v_response_status);
        END IF;
        IF v_http_response ? 'ack_headers' THEN
            v_response_headers := COALESCE(v_http_response->'ack_headers', v_response_headers);
        END IF;
        IF v_http_response ? 'ack_body' THEN
            v_response_body := COALESCE(v_http_response->'ack_body', v_response_body);
        END IF;
        IF v_http_response ? 'ack_outcome' THEN
            v_response_outcome := COALESCE(NULLIF(v_http_response->>'ack_outcome', ''), v_response_outcome);
        END IF;
        IF v_http_response ? 'ack_reason' THEN
            v_response_reason := COALESCE(NULLIF(v_http_response->>'ack_reason', ''), v_response_reason);
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

    IF v_response_headers IS NULL OR v_response_headers::TEXT = 'null' THEN
        v_response_headers := '{}'::jsonb;
    END IF;

    IF NOT (v_response_headers ? 'content-type') THEN
        v_response_headers := v_response_headers || jsonb_build_object('content-type', 'application/json');
    END IF;

    RETURN jsonb_strip_nulls(jsonb_build_object(
        'status', v_response_status,
        'headers', v_response_headers,
        'body', v_response_body,
        'ack_outcome', v_response_outcome,
        'ack_reason', v_response_reason,
        'webhook_id', v_webhook_id,
        'workflow_run_id', v_workflow_run_id,
        'followup_workflow_run_id', v_followup_run_id
    ));
END;
$function$;

COMMIT;

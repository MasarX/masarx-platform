-- Migration: Move webhook acknowledgement persistence into workflow engine handlers
-- Date: 2025-11-20 16:15 UTC

BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.persist_webhook_ack_v1(
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
    v_ack JSONB := COALESCE(v_context->'ack', '{}'::jsonb);
    v_validation JSONB := COALESCE(v_context->'validation', '{}'::jsonb);
    v_headers JSONB := COALESCE(v_context->'headers', '{}'::jsonb);
    v_payload JSONB := COALESCE(v_context->'payload', '{}'::jsonb);
    v_transformed_payload JSONB := COALESCE(v_context->'transformed_payload', v_payload);
    v_webhook_id UUID := NULLIF(v_context->>'webhook_id', '')::UUID;
    v_source_id UUID := NULLIF(v_context->>'webhook_source_id', '')::UUID;
    v_provider_type TEXT := NULLIF(v_context->>'provider_type', '');
    v_correlation_id UUID := NULLIF(v_context->>'correlation_id', '')::UUID;
    v_idempotency_key TEXT := NULLIF(v_context->>'idempotency_key', '');
    v_policy_settings_id UUID := NULLIF(v_context->>'policy_settings_id', '')::UUID;
    v_policy_scope_type TEXT := NULLIF(v_context->>'policy_scope_type', '');
    v_policy_scope_id UUID := NULLIF(v_context->>'policy_scope_id', '')::UUID;
    v_policy_version INT := COALESCE((v_context->>'policy_version')::INT, 1);
    v_organization_id UUID := NULLIF(v_context->>'organization_id', '')::UUID;
    v_decision_point TEXT := COALESCE(NULLIF(v_context->>'ack_decision_point', ''), 'workflow_intake_ack');
    v_ack_mode TEXT;
    v_ack_status INT;
    v_ack_headers JSONB;
    v_ack_body JSONB;
    v_ack_outcome TEXT;
    v_ack_reason TEXT;
    v_ack_sent_at TIMESTAMPTZ := now();
    v_history_id UUID;
    v_response workflow_handler_response;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    IF v_webhook_id IS NULL OR v_source_id IS NULL THEN
        RAISE EXCEPTION 'persist_webhook_ack_v1: webhook_id (%), source_id (%) required in workflow context', v_webhook_id, v_source_id;
    END IF;

    v_ack_mode := COALESCE(
        NULLIF(v_ack->>'ack_mode', ''),
        NULLIF(v_ack->>'mode', ''),
        'accepted_async'
    );

    v_ack_status := COALESCE(
        (v_ack->>'ack_status')::INT,
        (v_ack->>'status')::INT,
        CASE WHEN v_ack_mode = 'accepted_async' THEN 202 ELSE 200 END
    );

    v_ack_headers := jsonb_strip_nulls(COALESCE(v_ack->'ack_headers', v_ack->'header_defaults', '{}'::jsonb));
    v_ack_body := COALESCE(v_ack->'ack_body', NULL);
    v_ack_outcome := COALESCE(
        NULLIF(v_ack->>'ack_outcome', ''),
        NULLIF(v_ack->>'outcome', ''),
        'ack_sent'
    );
    v_ack_reason := COALESCE(
        NULLIF(v_ack->>'ack_reason', ''),
        NULLIF(v_ack->>'reason', '')
    );

    IF v_ack_headers IS NULL OR v_ack_headers::TEXT = 'null' THEN
        v_ack_headers := '{}'::jsonb;
    END IF;

    IF NOT (v_ack_headers ? 'content-type') THEN
        v_ack_headers := v_ack_headers || jsonb_build_object('content-type', 'application/json');
    END IF;

    IF v_ack_body IS NULL OR v_ack_body::TEXT = 'null' THEN
        IF v_ack_outcome = 'ack_failed' THEN
            v_ack_body := jsonb_build_object('error', COALESCE(v_ack_reason, 'Webhook acknowledgement failed'));
        ELSIF v_ack_mode = 'accepted_async' THEN
            v_ack_body := jsonb_strip_nulls(jsonb_build_object(
                'status', 'accepted_async',
                'correlation_id', v_context->>'correlation_id'
            ));
        ELSE
            v_ack_body := jsonb_build_object('status', 'accepted');
        END IF;
    END IF;

    IF v_ack_outcome = 'ack_failed' THEN
        v_ack_status := GREATEST(v_ack_status, 400);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM webhook_inbox WHERE id = v_webhook_id) THEN
        PERFORM insert_webhook_inbox_record(
            v_webhook_id,
            v_source_id,
            COALESCE(v_provider_type, 'unknown'),
            v_payload,
            v_headers,
            'in_progress',
            v_correlation_id,
            v_idempotency_key
        );
    END IF;

    UPDATE webhook_inbox
    SET ack_mode = v_ack_mode,
        ack_status_code = v_ack_status,
        ack_headers = v_ack_headers,
        ack_body = v_ack_body,
        ack_sent_at = v_ack_sent_at,
        ack_outcome = v_ack_outcome,
        ack_reason = v_ack_reason,
        ack_validation = v_validation,
        idempotency_key = v_idempotency_key,
        policy_settings_id = v_policy_settings_id,
        policy_scope_type = v_policy_scope_type,
        policy_scope_id = v_policy_scope_id,
        policy_version = v_policy_version,
        workflow_run_id = p_run.id,
        processing_status = 'in_progress',
        organization_id = COALESCE(organization_id, v_organization_id),
        provider_type = COALESCE(provider_type, v_provider_type),
        headers = v_headers,
        transformed_payload = v_transformed_payload,
        updated_at = v_ack_sent_at
    WHERE id = v_webhook_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'persist_webhook_ack_v1: webhook inbox % missing', v_webhook_id;
    END IF;

    INSERT INTO webhook_ack_history (
        id,
        webhook_inbox_id,
        webhook_source_id,
        ack_mode,
        ack_status_code,
        ack_headers,
        ack_body,
        ack_sent_at,
        ack_outcome,
        ack_reason,
        validation_results,
        policy_settings_id,
        policy_scope_type,
        policy_scope_id,
        policy_version,
        idempotency_key
    )
    VALUES (
        gen_random_uuid(),
        v_webhook_id,
        v_source_id,
        v_ack_mode,
        v_ack_status,
        v_ack_headers,
        v_ack_body,
        v_ack_sent_at,
        v_ack_outcome,
        v_ack_reason,
        COALESCE(v_validation, '{}'::jsonb),
        v_policy_settings_id,
        v_policy_scope_type,
        v_policy_scope_id,
        v_policy_version,
        v_idempotency_key
    )
    RETURNING id INTO v_history_id;

    PERFORM log_decision(
        p_organization_id := v_organization_id,
        p_decision_category := 'webhook_ack',
        p_resource_type := 'webhook_inbox',
        p_resource_id := v_webhook_id,
        p_decision_point := v_decision_point,
        p_decision_outcome := v_ack_outcome,
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'ack_status', v_ack_status,
            'ack_headers', v_ack_headers,
            'ack_body', v_ack_body,
            'validation_results', v_validation,
            'idempotency_key', v_idempotency_key
        )),
        p_decision_reason := v_ack_reason
    );

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'ack_status', v_ack_status,
        'ack_headers', v_ack_headers,
        'ack_body', v_ack_body,
        'ack_mode', v_ack_mode,
        'ack_outcome', v_ack_outcome,
        'ack_reason', v_ack_reason,
        'ack_history_id', v_history_id,
        'ack_sent_at', v_ack_sent_at
    ));

    v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
        'ack', v_response.operation_result,
        'ack_metadata', jsonb_strip_nulls(jsonb_build_object(
            'ack_history_id', v_history_id,
            'ack_sent_at', v_ack_sent_at
        )),
        'ack_persisted', TRUE,
        'webhook', jsonb_strip_nulls(jsonb_build_object(
            'processing_status', 'in_progress'
        ))
    ));

    RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.persist_webhook_ack_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Persist webhook acknowledgement data and emit audit decision from workflow context.';


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
    v_template_id UUID := NULLIF(v_followup->>'template_id', '')::UUID;
    v_template_context JSONB := COALESCE(v_followup->'context_patch', '{}'::jsonb);
    v_webhook_id UUID := NULLIF(v_context->>'webhook_id', '')::UUID;
    v_organization_id UUID := NULLIF(v_context->>'organization_id', '')::UUID;
    v_correlation_id UUID := NULLIF(v_context->>'correlation_id', '')::UUID;
    v_followup_run_id UUID;
    v_response workflow_handler_response;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    IF v_template_id IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('workflow_enqueued', FALSE);
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
        ))
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


INSERT INTO operation_handlers AS oh (
    handler_key,
    handler_schema,
    handler_name,
    handler_signature,
    handler_version,
    is_active,
    notes,
    doc_url
)
VALUES
    (
        'persist_webhook_ack',
        'workflow_handlers',
        'persist_webhook_ack_v1',
        '(public.workflow_run_steps,public.workflow_runs,jsonb)',
        'v1',
        TRUE,
        'Persist webhook acknowledgement information from workflow context.',
        'docs/ops/runbooks/webhook_engine_runbook.md'
    ),
    (
        'dispatch_webhook_followup',
        'workflow_handlers',
        'dispatch_followup_workflow_v1',
        '(public.workflow_run_steps,public.workflow_runs,jsonb)',
        'v1',
        TRUE,
        'Start configured follow-up workflow after acknowledgement persistence.',
        'docs/ops/runbooks/webhook_engine_runbook.md'
    )
ON CONFLICT (handler_key) DO UPDATE
SET
    handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();


INSERT INTO workflow_template_steps AS wts (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    handler_key,
    handler_version,
    metadata,
    manual_action_required,
    enabled
)
VALUES
    (
        '77770000-0000-0000-0000-000000770012',
        '77770000-0000-0000-0000-000000770001',
        2,
        'persist_ack',
        'workflow',
        'always',
        'persist_webhook_ack',
        'v1',
        '{}'::jsonb,
        FALSE,
        TRUE
    ),
    (
        '77770000-0000-0000-0000-000000770013',
        '77770000-0000-0000-0000-000000770001',
        3,
        'dispatch_followup',
        'workflow',
        'always',
        'dispatch_webhook_followup',
        'v1',
        '{}'::jsonb,
        FALSE,
        TRUE
    )
ON CONFLICT (id) DO UPDATE
SET
    handler_key = EXCLUDED.handler_key,
    handler_version = EXCLUDED.handler_version,
    sequence_order = EXCLUDED.sequence_order,
    metadata = EXCLUDED.metadata,
    manual_action_required = EXCLUDED.manual_action_required,
    enabled = EXCLUDED.enabled;


UPDATE workflow_template_steps
SET sequence_order = 1
WHERE id = '77770000-0000-0000-0000-000000770011';


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
    v_existing_ack RECORD;
    v_webhook_id UUID := gen_random_uuid();
    v_correlation_id UUID := gen_random_uuid();
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
    v_template_id UUID;
    v_workflow_run_id UUID;
    v_followup_run_id UUID;
    v_payload_for_db JSONB;
    v_raw_body_json JSONB;
    v_now TIMESTAMPTZ := now();
    v_started TIMESTAMPTZ := clock_timestamp();
    v_processing_ms INT := 0;
    v_decision_point TEXT;
    v_response_mapping_id UUID;
    v_run_context JSONB;
    v_progress JSONB;
    v_loop_count INT := 0;
    v_run_state JSONB;
    v_ack JSONB;
BEGIN
    IF v_payload IS NULL AND p_raw_body IS NOT NULL THEN
        BEGIN
            v_raw_body_json := p_raw_body::JSONB;
            v_payload := v_raw_body_json;
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
    v_decision_point := COALESCE(v_policy_body#>>'{logging,decision_point}', 'workflow_intake_ack');

    v_ack_mode := COALESCE(v_policy_body->'ack'->>'mode', 'accepted_async');
    IF v_ack_mode = 'accepted_async' THEN
        v_ack_status := 202;
    ELSE
        v_ack_status := COALESCE((v_policy_body->'ack'->>'status_code')::INT, 200);
    END IF;

    v_ack_headers := jsonb_strip_nulls(COALESCE(v_policy_body->'ack'->'default_headers', '{}'::jsonb));

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
    END IF;

    IF v_idempotency_key IS NULL THEN
        v_idempotency_key := COALESCE(
            NULLIF(v_payload->>'id', ''),
            NULLIF((v_payload->'event')->>'id', '')
        );
    END IF;

    v_validation := v_validation || jsonb_build_object(
        'idempotency',
        jsonb_strip_nulls(jsonb_build_object(
            'status', CASE WHEN v_idempotency_key IS NULL THEN 'skipped' ELSE 'passed' END,
            'key', v_idempotency_key
        ))
    );

    IF v_idempotency_key IS NOT NULL THEN
        v_idempotency_key := btrim(v_idempotency_key, '\"');
    END IF;

    IF v_idempotency_key IS NOT NULL THEN
        SELECT ack_status_code AS status_code,
               ack_headers,
               ack_body,
               ack_outcome
        INTO v_existing_ack
        FROM webhook_ack_history
        WHERE webhook_source_id = v_source.id
          AND idempotency_key = v_idempotency_key
        ORDER BY ack_sent_at DESC
        LIMIT 1;

        IF v_existing_ack.ack_outcome = 'ack_sent' THEN
            RETURN jsonb_build_object(
                'status', COALESCE(v_existing_ack.status_code, v_ack_status),
                'headers', COALESCE(v_existing_ack.ack_headers, '{}'::jsonb),
                'body', COALESCE(v_existing_ack.ack_body, jsonb_build_object()),
                'ack_outcome', 'ack_replayed'
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
                v_validation := v_validation || jsonb_build_object(
                    'hmac',
                    jsonb_build_object(
                        'status', 'failed',
                        'message', format('Missing signature header %s', v_signature_header)
                    )
                );
                v_ack_outcome := 'ack_failed';
                v_ack_reason := format('Missing signature header %s', v_signature_header);
                v_ack_status := GREATEST(v_ack_status, 400);
            ELSIF v_auth_config_id IS NULL THEN
                v_validation := v_validation || jsonb_build_object(
                    'hmac',
                    jsonb_build_object(
                        'status', 'failed',
                        'message', 'Missing auth_config reference for HMAC validation'
                    )
                );
                v_ack_outcome := 'ack_failed';
                v_ack_reason := 'Missing auth_config reference for HMAC validation';
                v_ack_status := GREATEST(v_ack_status, 400);
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
                    v_ack_outcome := 'ack_failed';
                    v_ack_reason := 'Signing secret missing';
                    v_ack_status := GREATEST(v_ack_status, 400);
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
                        v_ack_outcome := 'ack_failed';
                        v_ack_reason := 'HMAC signature mismatch';
                        v_ack_status := GREATEST(v_ack_status, 400);
                    ELSE
                        v_validation := v_validation || jsonb_build_object(
                            'hmac',
                            jsonb_build_object('status', 'passed')
                        );
                    END IF;
                END IF;
            END IF;
        END;
    END IF;

    v_payload_for_db := COALESCE(v_payload, '{}'::jsonb);

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
        'ack', jsonb_strip_nulls(jsonb_build_object(
            'mode', v_ack_mode,
            'status', v_ack_status,
            'header_defaults', v_ack_headers,
            'outcome', v_ack_outcome,
            'reason', v_ack_reason
        )),
        'response_mapping_id', v_response_mapping_id,
        'idempotency_key', v_idempotency_key,
        'organization_id', v_organization_id,
        'policy_scope_type', v_policy_scope_type,
        'policy_scope_id', v_policy_scope_id,
        'policy_settings_id', v_policy_settings_id,
        'policy_version', v_policy_version,
        'ack_decision_point', v_decision_point
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
            v_ack_outcome := 'ack_failed';
            v_ack_reason := COALESCE(v_progress->>'error', 'ack_handler_failure');
            v_ack_status := GREATEST(v_ack_status, 500);
            v_ack_headers := jsonb_build_object('content-type', 'application/json');
            v_ack_body := jsonb_build_object('error', v_ack_reason);
            EXIT;
        END IF;

        SELECT context
        INTO v_run_state
        FROM workflow_runs
        WHERE id = v_workflow_run_id;

        IF v_run_state IS NULL THEN
            EXIT;
        END IF;

        IF COALESCE(v_progress->>'handler_key', '') = 'dispatch_webhook_followup'
           AND COALESCE(v_progress->>'status', '') = 'completed'
           AND v_followup_run_id IS NULL THEN
            SELECT id
            INTO v_followup_run_id
            FROM workflow_runs
            WHERE metadata->>'started_by_run_id' = v_workflow_run_id::TEXT
            ORDER BY created_at DESC
            LIMIT 1;
        END IF;

        v_ack := COALESCE(v_run_state->'ack', '{}'::jsonb);

        IF v_ack ? 'ack_status' THEN
            v_ack_status := COALESCE((v_ack->>'ack_status')::INT, v_ack_status);
        END IF;
        IF v_ack ? 'ack_headers' THEN
            v_ack_headers := COALESCE(v_ack->'ack_headers', v_ack_headers);
        END IF;
        IF v_ack ? 'ack_body' THEN
            v_ack_body := COALESCE(v_ack->'ack_body', v_ack_body);
        END IF;
        IF v_ack ? 'ack_outcome' THEN
            v_ack_outcome := COALESCE(NULLIF(v_ack->>'ack_outcome', ''), v_ack_outcome);
        END IF;
        IF v_ack ? 'ack_reason' THEN
            v_ack_reason := COALESCE(NULLIF(v_ack->>'ack_reason', ''), v_ack_reason);
        END IF;
        IF v_ack ? 'ack_mode' THEN
            v_ack_mode := COALESCE(NULLIF(v_ack->>'ack_mode', ''), v_ack_mode);
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
        v_ack := COALESCE(v_run_state->'ack', v_ack);
        IF v_ack ? 'ack_status' THEN
            v_ack_status := COALESCE((v_ack->>'ack_status')::INT, v_ack_status);
        END IF;
        IF v_ack ? 'ack_headers' THEN
            v_ack_headers := COALESCE(v_ack->'ack_headers', v_ack_headers);
        END IF;
        IF v_ack ? 'ack_body' THEN
            v_ack_body := COALESCE(v_ack->'ack_body', v_ack_body);
        END IF;
        IF v_ack ? 'ack_outcome' THEN
            v_ack_outcome := COALESCE(NULLIF(v_ack->>'ack_outcome', ''), v_ack_outcome);
        END IF;
        IF v_ack ? 'ack_reason' THEN
            v_ack_reason := COALESCE(NULLIF(v_ack->>'ack_reason', ''), v_ack_reason);
        END IF;
        IF v_ack ? 'ack_mode' THEN
            v_ack_mode := COALESCE(NULLIF(v_ack->>'ack_mode', ''), v_ack_mode);
        END IF;
        v_followup_run_id := COALESCE(
            v_followup_run_id,
            NULLIF(v_run_state->>'followup_workflow_run_id', '')::UUID
        );

        IF NOT COALESCE((v_run_state->>'ack_persisted')::BOOLEAN, FALSE)
           AND v_ack_outcome NOT IN ('ack_sent', 'ack_replayed', 'ack_failed') THEN
            IF v_ack_outcome <> 'ack_failed' THEN
                v_ack_outcome := 'ack_failed';
                v_ack_reason := COALESCE(v_ack_reason, 'ack_persistence_missing');
            END IF;
            v_ack_status := GREATEST(v_ack_status, 500);
            v_ack_headers := jsonb_build_object('content-type', 'application/json');
            v_ack_body := jsonb_build_object('error', v_ack_reason);
        END IF;
    ELSE
        v_ack_outcome := 'ack_failed';
        v_ack_reason := COALESCE(v_ack_reason, 'ack_workflow_missing_context');
        v_ack_status := GREATEST(v_ack_status, 500);
        v_ack_headers := jsonb_build_object('content-type', 'application/json');
        v_ack_body := jsonb_build_object('error', v_ack_reason);
    END IF;

    IF v_ack_headers IS NULL OR v_ack_headers::TEXT = 'null' THEN
        v_ack_headers := '{}'::jsonb;
    END IF;
    IF NOT (v_ack_headers ? 'content-type') THEN
        v_ack_headers := v_ack_headers || jsonb_build_object('content-type', 'application/json');
    END IF;

    IF v_ack_body IS NULL OR v_ack_body::TEXT = 'null' THEN
        IF v_ack_outcome = 'ack_failed' THEN
            v_ack_body := jsonb_build_object('error', COALESCE(v_ack_reason, 'Webhook acknowledgement failed'));
        ELSIF v_ack_mode = 'accepted_async' THEN
            v_ack_body := jsonb_strip_nulls(jsonb_build_object(
                'status', 'accepted_async',
                'correlation_id', v_correlation_id
            ));
        ELSE
            v_ack_body := jsonb_build_object('status', 'accepted');
        END IF;
    END IF;

    IF v_ack_mode = 'accepted_async' AND v_followup_run_id IS NOT NULL THEN
        v_ack_body := jsonb_strip_nulls(v_ack_body || jsonb_build_object(
            'followup_workflow_run_id', v_followup_run_id
        ));
    END IF;

    v_ack_headers := jsonb_strip_nulls(v_ack_headers);
    v_ack_body := jsonb_strip_nulls(v_ack_body);

    IF v_ack_outcome = 'ack_failed' THEN
        v_ack_status := GREATEST(v_ack_status, 400);
    END IF;

    v_processing_ms := GREATEST(
        0,
        (extract(epoch FROM clock_timestamp() - v_started) * 1000)::INT
    );

    RETURN jsonb_strip_nulls(jsonb_build_object(
        'status', v_ack_status,
        'headers', v_ack_headers,
        'body', v_ack_body,
        'ack_outcome', v_ack_outcome,
        'webhook_id', v_webhook_id,
        'workflow_run_id', v_workflow_run_id,
        'followup_workflow_run_id', v_followup_run_id,
        'processing_time_ms', v_processing_ms
    ));
END;
$function$;


DROP FUNCTION IF EXISTS public.record_webhook_ack(
    UUID,
    UUID,
    TEXT,
    INT,
    JSONB,
    JSONB,
    TEXT,
    TEXT,
    JSONB,
    TIMESTAMPTZ,
    TEXT,
    UUID,
    TEXT,
    UUID,
    INT,
    UUID
);

COMMIT;


-- Migration: Webhook intake ack handler and template
-- Date: 2025-11-20

BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.compute_webhook_ack_v1(
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
    v_policy JSONB := COALESCE(v_context->'policy', '{}'::jsonb);
    v_ack JSONB := COALESCE(v_context->'ack', '{}'::jsonb);
    v_validation JSONB := COALESCE(v_context->'validation', '{}'::jsonb);
    v_headers JSONB := COALESCE(v_context->'headers', '{}'::jsonb);
    v_payload JSONB := COALESCE(v_context->'payload', '{}'::jsonb);
    v_response_mapping_id UUID := NULLIF(COALESCE(v_context->>'response_mapping_id', ''), '')::UUID;
    v_mapping JSONB;
    v_mode TEXT := COALESCE(v_ack->>'mode', 'accepted_async');
    v_status INT := COALESCE(NULLIF(v_ack->>'status', '')::INT, CASE WHEN v_mode = 'accepted_async' THEN 202 ELSE 200 END);
    v_outcome TEXT := COALESCE(v_ack->>'outcome', 'ack_sent');
    v_reason TEXT := NULLIF(v_ack->>'reason', '');
    v_header_defaults JSONB := COALESCE(v_ack->'header_defaults', '{}'::jsonb);
    v_headers_final JSONB := v_header_defaults;
    v_body JSONB;
    v_response workflow_handler_response;
    v_ack_context JSONB;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    IF v_response_mapping_id IS NOT NULL THEN
        SELECT mapping_config
        INTO v_mapping
        FROM mapping_configs
        WHERE id = v_response_mapping_id;
    END IF;

    IF v_mapping ? 'status_code' THEN
        v_status := COALESCE((v_mapping->>'status_code')::INT, v_status);
    END IF;

    IF v_mapping ? 'headers' THEN
        v_headers_final := jsonb_strip_nulls(COALESCE(v_mapping->'headers', '{}'::jsonb));
    END IF;

    IF v_mapping ? 'body' THEN
        v_body := render_template(
            v_mapping->'body',
            jsonb_build_object(
                'webhook', jsonb_strip_nulls(jsonb_build_object(
                    'id', v_context->>'webhook_id',
                    'correlation_id', v_context->>'correlation_id',
                    'source_identifier', v_context->>'source_identifier'
                )),
                'payload', v_payload,
                'headers', v_headers,
                'policy', v_policy,
                'validation', v_validation
            )
        );
    END IF;

    IF v_body IS NULL OR v_body::TEXT = 'null' THEN
        IF v_mode = 'accepted_async' THEN
            v_body := jsonb_strip_nulls(jsonb_build_object(
                'status', 'accepted_async',
                'correlation_id', v_context->>'correlation_id'
            ));
        ELSE
            v_body := jsonb_build_object('status', 'accepted');
        END IF;
    END IF;

    IF v_outcome = 'ack_failed' THEN
        v_status := GREATEST(v_status, 400);
        v_body := jsonb_build_object('error', COALESCE(v_reason, 'Webhook acknowledgement failed'));
    END IF;

    IF v_headers_final IS NULL OR v_headers_final::TEXT = 'null' THEN
        v_headers_final := '{}'::jsonb;
    END IF;

    IF NOT (v_headers_final ? 'content-type') THEN
        v_headers_final := v_headers_final || jsonb_build_object('content-type', 'application/json');
    END IF;

    v_ack_context := jsonb_strip_nulls(jsonb_build_object(
        'ack_status', v_status,
        'ack_headers', v_headers_final,
        'ack_body', v_body,
        'ack_mode', v_mode,
        'ack_outcome', v_outcome,
        'ack_reason', v_reason
    ));

    v_response.status := 'completed';
    v_response.operation_result := v_ack_context;
    v_response.context_patch := jsonb_build_object('ack', v_ack_context);

    RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.compute_webhook_ack_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Compute webhook acknowledgement payload based on intake policy context.';

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
VALUES (
    'compute_webhook_ack',
    'workflow_handlers',
    'compute_webhook_ack_v1',
    '(public.workflow_run_steps,public.workflow_runs,jsonb)',
    'v1',
    TRUE,
    'Render webhook acknowledgement status/headers/body from workflow context.',
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

INSERT INTO workflow_templates AS wt (
    id,
    name,
    description,
    version,
    status,
    scope_type,
    scope_id,
    notes
)
VALUES (
    '77770000-0000-0000-0000-000000770001',
    'webhook_intake_v1',
    'Canonical webhook intake pipeline; computes acknowledgement before delegating follow-up workflows.',
    1,
    'active',
    'global',
    NULL,
    'Workflow-engine-owned webhook intake ack pipeline'
)
ON CONFLICT (name) DO UPDATE
SET
    description = EXCLUDED.description,
    status = EXCLUDED.status,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id,
    notes = EXCLUDED.notes,
    updated_at = now()
RETURNING id;

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
VALUES (
    '77770000-0000-0000-0000-000000770011',
    '77770000-0000-0000-0000-000000770001',
    1,
    'compute_ack',
    'workflow',
    'always',
    'compute_webhook_ack',
    'v1',
    '{}'::jsonb,
    FALSE,
    TRUE
)
ON CONFLICT (id) DO UPDATE
SET
    handler_key = EXCLUDED.handler_key,
    handler_version = EXCLUDED.handler_version,
    metadata = EXCLUDED.metadata,
    manual_action_required = EXCLUDED.manual_action_required,
    enabled = EXCLUDED.enabled;

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
    v_validation_entry JSONB;
    v_duplicate JSONB;
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
    v_ack_result JSONB;
    v_context_patch JSONB := '{}'::jsonb;
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

        v_validation := v_validation || jsonb_build_object(
            'idempotency',
            jsonb_build_object(
                'status', CASE WHEN v_idempotency_key IS NULL THEN 'skipped' ELSE 'passed' END,
                'key', v_idempotency_key
            )
        );
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

    UPDATE webhook_inbox
    SET transformed_payload = v_payload_for_db
    WHERE id = v_webhook_id;

    v_response_mapping_id := NULLIF(v_policy_body->'ack'->>'response_mapping_id', '')::UUID;

    v_run_context := jsonb_strip_nulls(jsonb_build_object(
        'webhook_id', v_webhook_id,
        'webhook_source_id', v_source.id,
        'source_identifier', v_source.source_identifier,
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
        'policy_version', v_policy_version
    ));

    IF v_policy_body ? 'workflow' THEN
        v_run_context := v_run_context || jsonb_build_object('workflow', v_policy_body->'workflow');
    END IF;

    v_workflow_run_id := start_workflow_run(v_intake_template_id, v_run_context);

    v_progress := progress_workflow_run(v_workflow_run_id);

    IF COALESCE(v_progress->>'status', '') = 'failed' THEN
        v_ack_outcome := 'ack_failed';
        v_ack_reason := COALESCE(v_progress->>'error', 'ack_handler_failure');
        v_ack_status := GREATEST(v_ack_status, 500);
        v_ack_headers := jsonb_build_object('content-type', 'application/json');
        v_ack_body := jsonb_build_object('error', v_ack_reason);
    ELSE
        SELECT operation_result
        INTO v_ack_result
        FROM workflow_run_steps
        WHERE id = (v_progress->>'step_id')::UUID;

        IF v_ack_result IS NULL THEN
            v_ack_outcome := 'ack_failed';
            v_ack_reason := 'ack_handler_missing_result';
            v_ack_status := GREATEST(v_ack_status, 500);
            v_ack_headers := jsonb_build_object('content-type', 'application/json');
            v_ack_body := jsonb_build_object('error', v_ack_reason);
        ELSE
            v_ack_status := COALESCE((v_ack_result->>'ack_status')::INT, v_ack_status);
            v_ack_headers := COALESCE(v_ack_result->'ack_headers', '{}'::jsonb);
            v_ack_body := COALESCE(v_ack_result->'ack_body', jsonb_build_object());
            v_ack_outcome := COALESCE(v_ack_result->>'ack_outcome', v_ack_outcome);
            v_ack_reason := COALESCE(NULLIF(v_ack_result->>'ack_reason', ''), v_ack_reason);
            v_ack_mode := COALESCE(v_ack_result->>'ack_mode', v_ack_mode);
        END IF;
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

    IF v_ack_outcome = 'ack_failed' THEN
        v_ack_status := GREATEST(v_ack_status, 400);
    END IF;

    PERFORM record_webhook_ack(
        v_webhook_id,
        v_source.id,
        v_ack_mode,
        v_ack_status,
        v_ack_headers,
        v_ack_body,
        v_ack_outcome,
        v_ack_reason,
        v_validation,
        v_now,
        v_idempotency_key,
        v_policy_settings_id,
        v_policy_scope_type,
        v_policy_scope_id,
        v_policy_version,
        v_workflow_run_id
    );

    v_processing_ms := GREATEST(
        0,
        (extract(epoch FROM clock_timestamp() - v_started) * 1000)::INT
    );

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
            'ack_status', v_ack_status,
            'ack_headers', v_ack_headers,
            'ack_body', v_ack_body,
            'validation_results', v_validation,
            'idempotency_key', v_idempotency_key,
            'processing_time_ms', v_processing_ms
        )),
        p_decision_reason := v_ack_reason
    );

    UPDATE webhook_inbox
    SET processing_status = 'in_progress',
        organization_id = COALESCE(organization_id, v_organization_id),
        policy_scope_type = v_policy_scope_type,
        policy_scope_id = v_policy_scope_id,
        policy_settings_id = v_policy_settings_id,
        policy_version = v_policy_version,
        updated_at = now()
    WHERE id = v_webhook_id;

    v_template_id := NULLIF(v_policy_body#>>'{workflow,template_id}', '')::UUID;
    IF v_template_id IS NOT NULL THEN
        v_context_patch := COALESCE(v_policy_body->'workflow'->'context_patch', '{}'::jsonb);
        v_followup_run_id := start_workflow_run(
            v_template_id,
            jsonb_strip_nulls(
                jsonb_build_object(
                    'webhook_id', v_webhook_id,
                    'correlation_id', v_correlation_id,
                    'organization_id', v_organization_id,
                    'payload', v_payload,
                    'headers', v_headers,
                    'policy', v_policy_body,
                    'workflow_run_id', v_workflow_run_id
                ) || v_context_patch
            )
        );

        UPDATE workflow_runs
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'started_by_run_id', v_workflow_run_id,
                'started_by_step_id', '77770000-0000-0000-0000-000000770011'
            )
        WHERE id = v_followup_run_id;

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
                'workflow_template_id', v_template_id
            ),
            p_decision_reason := NULL
        );
    END IF;

    RETURN jsonb_strip_nulls(jsonb_build_object(
        'status', v_ack_status,
        'headers', v_ack_headers,
        'body', v_ack_body,
        'ack_outcome', v_ack_outcome,
        'webhook_id', v_webhook_id,
        'workflow_run_id', v_workflow_run_id,
        'followup_workflow_run_id', v_followup_run_id
    ));
END;
$function$;

COMMENT ON FUNCTION workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB)
    IS 'Single entrypoint for webhooks: resolves policy, records ack, and enqueues workflow run.';

COMMIT;

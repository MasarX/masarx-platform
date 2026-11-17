-- Migration: Webhook single-pipeline workflow intake
-- Purpose: Remove workflow follow-up artifacts, introduce workflow_intake_webhook, and link inbox rows directly to workflow runs.
-- Date: 2025-11-20

BEGIN;

-------------------------------------------------------------------------------
-- Schema adjustments: webhook_inbox columns and indexes
-------------------------------------------------------------------------------

ALTER TABLE webhook_inbox
    DROP COLUMN IF EXISTS workflow_followup_actions,
    DROP COLUMN IF EXISTS workflow_followup_workflow_id,
    DROP COLUMN IF EXISTS workflow_followup_workflow_run_id;

ALTER TABLE webhook_inbox
    ADD COLUMN IF NOT EXISTS workflow_run_id UUID;

COMMENT ON COLUMN webhook_inbox.workflow_run_id
    IS 'Primary workflow run driving all post-intake processing for this webhook.';

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_workflow_run
    ON webhook_inbox(workflow_run_id);

-------------------------------------------------------------------------------
-- Deprecate legacy workflow follow-up helpers and templates
-------------------------------------------------------------------------------

-- Drop wrapper workflow template and associated steps.
DELETE FROM workflow_template_steps
WHERE workflow_template_id IN (
    SELECT id FROM workflow_templates WHERE name = 'workflow_followup_actions_wrapper_v1'
);

DELETE FROM workflow_templates
WHERE name = 'workflow_followup_actions_wrapper_v1';

-- Remove legacy operation template records used exclusively by the wrapper.
DELETE FROM operation_templates
WHERE id IN (
    '99990000-0000-0000-0000-000000340101',
    '99990000-0000-0000-0000-000000340102',
    '99990000-0000-0000-0000-000000340103',
    '99990000-0000-0000-0000-000000340104'
);

-- Remove handler registrations that were dedicated to workflow follow-up wrapper.
DELETE FROM operation_handlers
WHERE handler_key IN ('workflow_followup_notification', 'workflow_followup_geocode');

-- Drop obsolete helper functions (tolerate stale versions from prior migrations).
DROP FUNCTION IF EXISTS worker_action_start_workflow(UUID, JSONB, JSONB);
DROP FUNCTION IF EXISTS worker_action_call_supplier_api(UUID, JSONB, JSONB);
DROP FUNCTION IF EXISTS worker_action_enqueue_notification(UUID, JSONB, JSONB);
DROP FUNCTION IF EXISTS worker_action_geocode_enrich(UUID, JSONB, JSONB);
DROP FUNCTION IF EXISTS execute_workflow_followup_actions(UUID, JSONB, JSONB);
DROP FUNCTION IF EXISTS start_workflow_followup_actions_workflow(UUID, JSONB, JSONB);
DROP FUNCTION IF EXISTS workflow_handlers.execute_workflow_followup_notification_v1(workflow_run_steps, workflow_runs, JSONB);
DROP FUNCTION IF EXISTS workflow_handlers.execute_workflow_followup_geocode_v1(workflow_run_steps, workflow_runs, JSONB);
DROP TABLE IF EXISTS worker_action_handlers;

-------------------------------------------------------------------------------
-- Ensure edge roles exist (idempotent)
-------------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_webhook_role') THEN
        CREATE ROLE edge_webhook_role NOLOGIN;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_caller_role') THEN
        CREATE ROLE edge_api_caller_role NOLOGIN;
    END IF;
END;
$$;

-------------------------------------------------------------------------------
-- Drop legacy acknowledgement helper signature prior to redefinition
-------------------------------------------------------------------------------

DROP FUNCTION IF EXISTS record_webhook_ack(
    UUID, UUID, TEXT, INT, UUID, TEXT, UUID, INT, JSONB, JSONB, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, JSONB, UUID
);

-------------------------------------------------------------------------------
-- Helper: JSON path resolver (dot notation) for policy-driven lookups
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.jsonb_resolve_path(
    p_data JSONB,
    p_path TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_segment TEXT;
    v_segments TEXT[];
    v_cursor JSONB := p_data;
BEGIN
    IF p_data IS NULL OR p_path IS NULL OR btrim(p_path) = '' THEN
        RETURN NULL;
    END IF;

    v_segments := string_to_array(p_path, '.');
    FOREACH v_segment IN ARRAY v_segments LOOP
        IF v_cursor IS NULL THEN
            RETURN NULL;
        END IF;

        IF jsonb_typeof(v_cursor) = 'array' THEN
            BEGIN
                v_cursor := v_cursor->(v_segment::INT);
            EXCEPTION
                WHEN invalid_text_representation THEN
                    RETURN NULL;
            END;
        ELSE
            v_cursor := v_cursor->v_segment;
        END IF;
    END LOOP;

    RETURN v_cursor;
END;
$$;

COMMENT ON FUNCTION public.jsonb_resolve_path(JSONB, TEXT)
    IS 'Resolve dot-delimited path (array segments allowed) within a JSONB document.';

-------------------------------------------------------------------------------
-- Helper: normalize header keys to lowercase text map
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.normalize_headers(p_headers JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT COALESCE(
        jsonb_object_agg(lower(key), value),
        '{}'::jsonb
    )
    FROM jsonb_each(p_headers)
$$;

COMMENT ON FUNCTION public.normalize_headers(JSONB)
    IS 'Lower-case header keys for consistent comparisons.';

-------------------------------------------------------------------------------
-- Helper: Mustache-style template rendering for JSON payloads
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.render_template(
    p_template JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_result JSONB;
    v_entry RECORD;
    v_index INT := 0;
    v_text TEXT;
    v_matches TEXT[];
    v_token TEXT;
    v_value JSONB;
    v_replacement TEXT;
    v_rendered TEXT;
BEGIN
    IF p_template IS NULL THEN
        RETURN NULL;
    END IF;

    IF jsonb_typeof(p_template) = 'object' THEN
        v_result := '{}'::jsonb;
        FOR v_entry IN SELECT key, value FROM jsonb_each(p_template) LOOP
            v_result := jsonb_set(
                v_result,
                ARRAY[v_entry.key],
                render_template(v_entry.value, p_context),
                TRUE
            );
        END LOOP;
        RETURN v_result;
    ELSIF jsonb_typeof(p_template) = 'array' THEN
        v_result := '[]'::jsonb;
        FOR v_entry IN
            SELECT value, ordinality
            FROM jsonb_array_elements(p_template) WITH ORDINALITY AS arr(value, ordinality)
        LOOP
            v_result := v_result || jsonb_build_array(render_template(v_entry.value, p_context));
        END LOOP;
        RETURN v_result;
    ELSIF jsonb_typeof(p_template) = 'string' THEN
        v_text := trim(both '"' FROM p_template::TEXT);
        IF position('{{' IN v_text) = 0 THEN
            RETURN to_jsonb(v_text);
        END IF;

        v_rendered := v_text;
        FOR v_matches IN SELECT regexp_matches(v_text, '\{\{\s*([^}]+)\s*\}\}', 'g') LOOP
            v_token := v_matches[1];
            v_value := jsonb_resolve_path(p_context, v_token);
            IF v_value IS NULL OR v_value::TEXT = 'null' THEN
                v_replacement := '';
            ELSIF jsonb_typeof(v_value) IN ('object', 'array') THEN
                v_replacement := v_value::TEXT;
            ELSE
                v_replacement := trim(both '"' FROM v_value::TEXT);
            END IF;
            v_rendered := regexp_replace(
                v_rendered,
                '\{\{\s*' || regexp_replace(v_token, '([\\\^\$\.\|\?\*\+\(\)\[\{\]])', '\\\1', 'g') || '\s*\}\}',
                v_replacement,
                'g'
            );
        END LOOP;

        RETURN to_jsonb(v_rendered);
    END IF;

    RETURN p_template;
END;
$$;

COMMENT ON FUNCTION public.render_template(JSONB, JSONB)
    IS 'Render JSON template replacing {{tokens}} using dot-path lookups within context.';

-------------------------------------------------------------------------------
-- Updated record_webhook_ack without workflow follow-up payloads
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION record_webhook_ack(
    p_webhook_inbox_id UUID,
    p_webhook_source_id UUID,
    p_ack_mode TEXT,
    p_ack_status_code INT,
    p_ack_headers JSONB,
    p_ack_body JSONB,
    p_ack_outcome TEXT,
    p_ack_reason TEXT,
    p_validation_results JSONB,
    p_ack_sent_at TIMESTAMPTZ,
    p_idempotency_key TEXT,
    p_policy_settings_id UUID,
    p_policy_scope_type TEXT,
    p_policy_scope_id UUID,
    p_policy_version INT,
    p_workflow_run_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE webhook_inbox
    SET ack_mode = p_ack_mode,
        ack_status_code = p_ack_status_code,
        ack_headers = COALESCE(p_ack_headers, '{}'::jsonb),
        ack_body = p_ack_body,
        ack_sent_at = COALESCE(p_ack_sent_at, now()),
        ack_outcome = p_ack_outcome,
        ack_reason = p_ack_reason,
        ack_validation = COALESCE(p_validation_results, '{}'::jsonb),
        idempotency_key = p_idempotency_key,
        policy_settings_id = p_policy_settings_id,
        policy_scope_type = p_policy_scope_type,
        policy_scope_id = p_policy_scope_id,
        policy_version = p_policy_version,
        workflow_run_id = COALESCE(p_workflow_run_id, workflow_run_id)
    WHERE id = p_webhook_inbox_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook_inbox entry % not found when recording acknowledgement', p_webhook_inbox_id;
    END IF;

    INSERT INTO webhook_ack_history (
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
        p_webhook_inbox_id,
        p_webhook_source_id,
        p_ack_mode,
        p_ack_status_code,
        COALESCE(p_ack_headers, '{}'::jsonb),
        p_ack_body,
        COALESCE(p_ack_sent_at, now()),
        p_ack_outcome,
        p_ack_reason,
        COALESCE(p_validation_results, '{}'::jsonb),
        p_policy_settings_id,
        p_policy_scope_type,
        p_policy_scope_id,
        p_policy_version,
        p_idempotency_key
    );
END;
$$;

COMMENT ON FUNCTION record_webhook_ack(UUID, UUID, TEXT, INT, JSONB, JSONB, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, UUID, TEXT, UUID, INT, UUID)
    IS 'Persist acknowledgement metadata onto webhook_inbox + webhook_ack_history (single pipeline).';

REVOKE EXECUTE ON FUNCTION record_webhook_ack(UUID, UUID, TEXT, INT, JSONB, JSONB, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, UUID, TEXT, UUID, INT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_webhook_ack(UUID, UUID, TEXT, INT, JSONB, JSONB, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, UUID, TEXT, UUID, INT, UUID) TO edge_webhook_role;
GRANT EXECUTE ON FUNCTION record_webhook_ack(UUID, UUID, TEXT, INT, JSONB, JSONB, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, UUID, TEXT, UUID, INT, UUID) TO service_role;

-------------------------------------------------------------------------------
-- Workflow intake entrypoint (single pipeline orchestration)
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
    v_context_patch JSONB := '{}'::jsonb;
    v_validation_entry JSONB;
    v_duplicate JSONB;
    v_template_id UUID;
    v_workflow_run_id UUID;
    v_payload_for_db JSONB;
    v_raw_body_json JSONB;
    v_now TIMESTAMPTZ := now();
    v_started TIMESTAMPTZ := clock_timestamp();
    v_processing_ms INT := 0;
    v_decision_point TEXT;
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
        -- Fall back to empty JSON object for consistent processing.
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

    -- Determine acknowledgement mode/status defaults.
    v_ack_mode := COALESCE(v_policy_body->'ack'->>'mode', 'accepted_async');
    IF v_ack_mode = 'accepted_async' THEN
        v_ack_status := 202;
    ELSE
        v_ack_status := COALESCE((v_policy_body->'ack'->>'status_code')::INT, 200);
    END IF;

    -- Schema validation placeholder: record configured schema, defer evaluation to workflow handlers.
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

    -- Idempotency controls.
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

    -- HMAC verification.
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

    -- Persist inbox row (always store raw payload + headers).
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

    -- Compute acknowledgement mapping.
    IF v_policy_body->'ack' ? 'response_mapping_id' THEN
        SELECT mapping_config
        INTO v_mapping
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
        v_ack_body := render_template(v_mapping->'body', jsonb_build_object(
            'webhook', jsonb_build_object(
                'id', v_webhook_id,
                'correlation_id', v_correlation_id,
                'source_identifier', v_source.source_identifier
            ),
            'payload', v_payload,
            'headers', v_headers,
            'policy', v_policy_body,
            'validation', v_validation
        ));
    END IF;

    IF v_ack_body IS NULL OR v_ack_body::TEXT = 'null' THEN
        IF v_ack_mode = 'accepted_async' THEN
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
        NULL
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

    -- Launch follow-up workflow if configured.
    v_template_id := NULLIF(v_policy_body#>>'{workflow,template_id}', '')::UUID;
    IF v_template_id IS NOT NULL THEN
        v_context_patch := COALESCE(v_policy_body->'workflow'->'context_patch', '{}'::jsonb);
        v_workflow_run_id := start_workflow_run(
            v_template_id,
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
                'workflow_run_id', v_workflow_run_id,
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
        'workflow_run_id', v_workflow_run_id
    ));
END;
$$;

COMMENT ON FUNCTION workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB)
    IS 'Single entrypoint for webhooks: resolves policy, records ack, and enqueues workflow run.';

REVOKE EXECUTE ON FUNCTION workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) TO edge_webhook_role;
GRANT EXECUTE ON FUNCTION workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) TO service_role;

-------------------------------------------------------------------------------
-- Simplify webhook worker: progress workflow runs only
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION run_webhook_processor_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_pending_run RECORD;
BEGIN
    SELECT * INTO v_throttle FROM public.check_throttle('webhook_processor_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := create_request_context('webhook_processor_worker');

    FOR v_pending_run IN
        SELECT id
        FROM workflow_runs
        WHERE workflow_status IN ('pending', 'in_progress')
          AND (
                current_step_id IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM workflow_run_steps wrs
                    WHERE wrs.workflow_run_id = workflow_runs.id
                      AND wrs.step_status = 'pending'
                      AND wrs.run_at <= now()
                )
                OR EXISTS (
                    SELECT 1
                    FROM workflow_run_steps wrs
                    WHERE wrs.workflow_run_id = workflow_runs.id
                      AND wrs.step_status = 'in_progress'
                      AND wrs.operation_completed_at IS NULL
                )
          )
        ORDER BY created_at ASC
        LIMIT v_throttle.batch_size
        FOR UPDATE SKIP LOCKED
    LOOP
        BEGIN
            PERFORM progress_workflow_run(v_pending_run.id);
            v_items_processed := v_items_processed + 1;
        EXCEPTION
            WHEN OTHERS THEN
                v_error := TRUE;
        END;
    END LOOP;

    PERFORM complete_request_context(v_context, v_error, v_items_processed);
    PERFORM update_cron_config('webhook_processor_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'error', v_error
    );
END;
$function$;

COMMENT ON FUNCTION run_webhook_processor_worker()
    IS 'Progress webhook-associated workflow runs respecting throttling.';

COMMIT;



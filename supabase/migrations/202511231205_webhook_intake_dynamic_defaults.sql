-- Migration: Webhook intake dynamic defaults & policy upsert helper
-- Purpose:
--   * Store HTTP response defaults in webhook_intake settings.
--   * Expose helper to resolve defaults at runtime.
--   * Add upsert_webhook_ingest_policy(scope, scope_id, policy) helper.

BEGIN;

SET search_path TO public;

-------------------------------------------------------------------------------
-- 1. Extend global webhook_intake settings with default response config
-------------------------------------------------------------------------------

WITH existing AS (
    SELECT
        sv.id AS settings_version_id,
        s.id AS settings_id,
        sv.value
    FROM settings_versions sv
    JOIN settings s
      ON s.settings_version_id = sv.id
     AND s.category = sv.category
     AND s.scope_type = sv.scope_type
     AND (s.scope_id IS NOT DISTINCT FROM sv.scope_id)
    WHERE sv.category = 'webhook_intake'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
    LIMIT 1
)
UPDATE settings_versions sv
SET value = jsonb_strip_nulls(
        COALESCE(sv.value, '{}'::jsonb)
        || jsonb_build_object(
            'defaults', jsonb_build_object(
                'accepted_async_status', 202,
                'synchronous_success_status', 200,
                'bad_request_status', 400,
                'error_status', 500,
                'poll_attempts', 5,
                'poll_interval_ms', 50
            )
        )
    )
FROM existing e
WHERE sv.id = e.settings_version_id;

WITH existing AS (
    SELECT
        sv.id AS settings_version_id,
        s.id AS settings_id,
        sv.value
    FROM settings_versions sv
    JOIN settings s
      ON s.settings_version_id = sv.id
     AND s.category = sv.category
     AND s.scope_type = sv.scope_type
     AND (s.scope_id IS NOT DISTINCT FROM sv.scope_id)
    WHERE sv.category = 'webhook_intake'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
    LIMIT 1
)
UPDATE settings s
SET cached_value = jsonb_strip_nulls(
        COALESCE(s.cached_value, '{}'::jsonb)
        || jsonb_build_object(
            'defaults', jsonb_build_object(
                'accepted_async_status', 202,
                'synchronous_success_status', 200,
                'bad_request_status', 400,
                'error_status', 500,
                'poll_attempts', 5,
                'poll_interval_ms', 50
            )
        )
    ),
    last_updated = now()
FROM existing e
WHERE s.id = e.settings_id;

-------------------------------------------------------------------------------
-- 2. Helper: resolve webhook intake defaults for organization scope
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION resolve_webhook_intake_defaults(p_organization_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
    v_settings JSONB;
    v_defaults JSONB;
    /* objectives:allow TENANT_LITERAL Justification: sentinel UUID used for error context when organization_id is NULL; not a real tenant id */
    v_scope UUID := COALESCE(p_organization_id, '00000000-0000-0000-0000-000000000000'::UUID);
    v_required TEXT[] := ARRAY[
        'accepted_async_status',
        'synchronous_success_status',
        'bad_request_status',
        'error_status',
        'poll_attempts',
        'poll_interval_ms'
    ];
    v_key TEXT;
BEGIN
    v_settings := resolve_settings('webhook_intake', 'tenant', p_organization_id);
    IF v_settings IS NULL THEN
        v_settings := resolve_settings('webhook_intake', 'global', NULL);
    END IF;

    IF v_settings IS NULL THEN
        RAISE EXCEPTION 'webhook_intake settings missing for organization %', v_scope;
    END IF;

    v_defaults := COALESCE(v_settings->'defaults', '{}'::jsonb);
    FOREACH v_key IN ARRAY v_required LOOP
        IF v_defaults->>v_key IS NULL THEN
            RAISE EXCEPTION 'webhook_intake defaults missing key % for organization %', v_key, v_scope;
        END IF;
    END LOOP;

    RETURN jsonb_strip_nulls(v_defaults);
END;
$$;

GRANT EXECUTE ON FUNCTION resolve_webhook_intake_defaults(UUID) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 3. Helper: upsert webhook ingest policy for any scope
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION upsert_webhook_ingest_policy(
    p_scope_type TEXT,
    p_scope_id UUID,
    p_policy JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_scope_type TEXT := lower(trim(p_scope_type));
    v_scope_id UUID := p_scope_id;
    v_scope_hash UUID;
    v_policy JSONB;
    v_existing settings%ROWTYPE;
    v_sv_id UUID := gen_random_uuid();
    v_s_id UUID;
    v_next_version INT;
    v_allowed_scope_types CONSTANT TEXT[] := ARRAY['global', 'tenant', 'client', 'sender', 'source'];
BEGIN
    IF v_scope_type NOT IN (SELECT UNNEST(v_allowed_scope_types)) THEN
        RAISE EXCEPTION 'invalid scope_type %, expected one of %', v_scope_type, v_allowed_scope_types;
    END IF;

    IF v_scope_type = 'global' THEN
        IF v_scope_id IS NOT NULL THEN
            RAISE EXCEPTION 'global scope requires NULL scope_id';
        END IF;
        v_scope_hash := '00000000-0000-0000-0000-000000000000';
    ELSE
        IF v_scope_id IS NULL THEN
            RAISE EXCEPTION 'scope_id required for scope_type %', v_scope_type;
        END IF;
        v_scope_hash := v_scope_id;
    END IF;

    v_policy := COALESCE(p_policy, '{}'::jsonb);

    SELECT *
      INTO v_existing
      FROM settings
     WHERE category = 'webhook_ingest_policy'
       AND scope_type = v_scope_type
       AND (scope_id IS NOT DISTINCT FROM v_scope_id)
     LIMIT 1;

    SELECT COALESCE(MAX(version) + 1, 1)
      INTO v_next_version
      FROM settings_versions
     WHERE category = 'webhook_ingest_policy'
       AND scope_type = v_scope_type
       AND (scope_id IS NOT DISTINCT FROM v_scope_id);

    INSERT INTO settings_versions (
        id, category, scope_type, scope_id, scope_hash, version,
        value, schema_version, change_reason, approved_at, effective_from
    ) VALUES (
        v_sv_id,
        'webhook_ingest_policy',
        v_scope_type,
        v_scope_id,
        v_scope_hash,
        v_next_version,
        v_policy,
        1,
        format('upsert webhook_ingest_policy (%s)', v_scope_type),
        now(),
        now()
    );

    IF v_existing.id IS NULL THEN
        v_s_id := gen_random_uuid();
        INSERT INTO settings (
            id, category, scope_type, scope_id, scope_hash,
            settings_version_id, cached_value, last_updated
        ) VALUES (
            v_s_id,
            'webhook_ingest_policy',
            v_scope_type,
            v_scope_id,
            v_scope_hash,
            v_sv_id,
            v_policy,
            now()
        );
    ELSE
        v_s_id := v_existing.id;
        UPDATE settings
           SET settings_version_id = v_sv_id,
               cached_value = v_policy,
               last_updated = now()
         WHERE id = v_existing.id;
    END IF;

    RETURN v_s_id;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_webhook_ingest_policy(TEXT, UUID, JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 4. Update render_http_response handler to use dynamic defaults
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.render_http_response_v1(
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
    v_headers JSONB := COALESCE(v_context->'headers', '{}'::jsonb);
    v_payload JSONB := COALESCE(v_context->'payload', '{}'::jsonb);
    v_validation JSONB := COALESCE(v_context->'validation', '{}'::jsonb);
    v_response JSONB := COALESCE(v_context->'http_response', v_context->'response', '{}'::jsonb);
    v_response_mapping_id UUID := NULLIF(v_context->>'response_mapping_id', '')::UUID;
    v_mapping JSONB;
    v_org UUID := NULLIF(v_context->>'organization_id', '')::UUID;
    v_defaults JSONB := resolve_webhook_intake_defaults(v_org);
    v_status_async INT := (v_defaults->>'accepted_async_status')::INT;
    v_status_sync INT := (v_defaults->>'synchronous_success_status')::INT;
    v_status_bad INT := (v_defaults->>'bad_request_status')::INT;
    v_status_error INT := (v_defaults->>'error_status')::INT;
    v_mode TEXT := COALESCE(v_response->>'mode', COALESCE(v_policy->'ack'->>'mode', 'accepted_async'));
    v_status INT := COALESCE(
        NULLIF(v_response->>'status', '')::INT,
        COALESCE(
            (v_policy->'ack'->>'status_code')::INT,
            CASE WHEN v_mode = 'accepted_async' THEN v_status_async ELSE v_status_sync END
        )
    );
    v_outcome TEXT := COALESCE(NULLIF(v_response->>'outcome', ''), COALESCE(v_policy->'ack'->>'default_outcome', 'response_sent'));
    v_reason TEXT := NULLIF(v_response->>'reason', '');
    v_header_defaults JSONB := COALESCE(v_policy->'ack'->'default_headers', '{}'::jsonb);
    v_headers_final JSONB := jsonb_strip_nulls(COALESCE(v_response->'headers', v_header_defaults, '{}'::jsonb));
    v_body JSONB := v_response->'body';
    v_result workflow_handler_response;
    v_http_context JSONB;
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

    IF v_outcome = 'response_failed' THEN
        v_status := COALESCE(
            NULLIF(v_response->>'fail_status', '')::INT,
            COALESCE((v_policy->'ack'->>'fail_status')::INT, v_status_bad)
        );
        v_body := jsonb_build_object('error', COALESCE(v_reason, 'Webhook response failed'));
    END IF;

    IF v_headers_final IS NULL OR v_headers_final::TEXT = 'null' THEN
        v_headers_final := '{}'::jsonb;
    END IF;

    IF NOT (v_headers_final ? 'content-type') THEN
        v_headers_final := v_headers_final || jsonb_build_object('content-type', 'application/json');
    END IF;

    v_http_context := jsonb_strip_nulls(jsonb_build_object(
        'status', v_status,
        'headers', v_headers_final,
        'body', v_body,
        'mode', v_mode,
        'outcome', v_outcome,
        'reason', v_reason
    ));

    v_result.status := 'completed';
    v_result.operation_result := v_http_context;
    v_result.context_patch := jsonb_build_object('http_response', v_http_context);

    RETURN v_result;
END;
$function$;

-------------------------------------------------------------------------------
-- 5. Update workflow_intake_webhook to consume dynamic defaults
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.workflow_intake_webhook(
    p_token TEXT,
    p_headers JSONB,
    p_raw_body TEXT,
    p_payload JSONB DEFAULT NULL::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
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
    v_response_status INT;
    v_response_headers JSONB := '{}'::jsonb;
    v_response_body JSONB;
    v_response_mode TEXT := 'accepted_async';
    v_response_outcome TEXT := 'response_sent';
    v_response_reason TEXT;
    v_header_defaults JSONB;
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
    v_defaults JSONB;
    v_status_async INT;
    v_status_sync INT;
    v_status_bad INT;
    v_status_error INT;
    v_poll_attempts INT;
    v_poll_interval_ms INT;
    v_default_response JSONB;
    v_default_status INT;
    v_default_body JSONB;
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
    v_defaults := resolve_webhook_intake_defaults(v_organization_id);
    v_status_async := (v_defaults->>'accepted_async_status')::INT;
    v_status_sync := (v_defaults->>'synchronous_success_status')::INT;
    v_status_bad := (v_defaults->>'bad_request_status')::INT;
    v_status_error := (v_defaults->>'error_status')::INT;
    v_poll_attempts := GREATEST((v_defaults->>'poll_attempts')::INT, 1);
    v_poll_interval_ms := GREATEST((v_defaults->>'poll_interval_ms')::INT, 1);
    v_response_status := v_status_async;

    SELECT * INTO v_policy
    FROM resolve_webhook_ingest_policy(p_webhook_source_id := v_source.id)
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status', v_status_error,
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
                'status', v_status_error,
                'headers', jsonb_build_object('content-type', 'application/json'),
                'body', jsonb_build_object('error', 'Webhook workflow template not configured'),
                'mode', v_response_mode,
                'outcome', 'response_failed',
                'reason', 'workflow_template_missing',
                'workflow_run_id', NULL,
                'followup_workflow_run_id', NULL,
                'validation_results', v_validation,
                'idempotency_key', NULL,
                'processing_ms', 0
            )),
            p_decision_reason := 'Webhook workflow template not configured'
        );

        RETURN jsonb_build_object(
            'status', v_status_error,
            'headers', jsonb_build_object('content-type', 'application/json'),
            'body', jsonb_build_object('error', 'Webhook workflow template not configured'),
            'response_outcome', 'response_failed'
        );
    END IF;

    v_response_mapping_id := NULLIF(v_policy_body#>>'{response,response_mapping_id}', '')::UUID;

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
                v_response_status := GREATEST(v_response_status, v_status_bad);
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
                v_response_status := GREATEST(v_response_status, v_status_bad);
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
                    v_response_status := GREATEST(v_response_status, v_status_bad);
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
                        v_response_status := GREATEST(v_response_status, v_status_bad);
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
        v_response_status := GREATEST(v_response_status, v_status_bad);
        IF v_response_headers IS NULL OR v_response_headers::TEXT = 'null' THEN
            v_response_headers := jsonb_build_object('content-type', 'application/json');
        END IF;
        IF v_response_body IS NULL OR v_response_body::TEXT = 'null' THEN
            v_response_body := jsonb_build_object('error', COALESCE(v_response_reason, 'Webhook validation failed'));
        END IF;
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
                p_decision_category := 'http_response_emitted',
                p_resource_type := 'webhook_inbox',
                p_resource_id := v_existing_response.webhook_id,
                p_decision_point := COALESCE(v_policy_body#>>'{logging,decision_point}', 'workflow_intake_response'),
                p_decision_outcome := 'response_replayed',
                p_performed_by_system := 'workflow_intake_webhook',
                p_correlation_id := v_correlation_id,
                p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'status', COALESCE(v_existing_response.http_status_code, v_status_async),
                    'headers', COALESCE(v_existing_response.http_headers, '{}'::jsonb),
                    'body', COALESCE(v_existing_response.http_body, jsonb_build_object('status', 'accepted_async')),
                    'mode', COALESCE(v_existing_response.response_mode, 'accepted_async'),
                    'outcome', 'response_replayed',
                    'reason', v_existing_response.response_reason,
                    'workflow_run_id', v_existing_response.workflow_run_id,
                    'followup_workflow_run_id', v_followup_run_id,
                    'validation_results', v_validation,
                    'idempotency_key', v_idempotency_key,
                    'processing_ms', 0
                )),
                p_decision_reason := v_existing_response.response_reason
            );

            RETURN jsonb_strip_nulls(jsonb_build_object(
                'status', COALESCE(v_existing_response.http_status_code, v_status_async),
                'headers', COALESCE(v_existing_response.http_headers, '{}'::jsonb),
                'body', COALESCE(v_existing_response.http_body, jsonb_build_object('status', 'accepted_async')),
                'response_outcome', 'response_replayed',
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

    v_header_defaults := jsonb_strip_nulls(COALESCE(v_policy_body->'ack'->'default_headers', '{}'::jsonb));
    v_default_status := CASE WHEN v_ack_mode = 'accepted_async' THEN v_status_async ELSE v_status_sync END;
    v_default_body := CASE
        WHEN v_ack_mode = 'accepted_async' THEN jsonb_strip_nulls(jsonb_build_object(
            'status', 'accepted_async',
            'correlation_id', v_correlation_id
        ))
        ELSE jsonb_build_object('status', 'accepted')
    END;
    v_response_status := v_default_status;
    v_default_response := jsonb_strip_nulls(jsonb_build_object(
        'status', v_default_status,
        'headers', v_header_defaults,
        'body', v_default_body,
        'mode', v_ack_mode,
        'outcome', v_response_outcome,
        'reason', v_response_reason
    ));

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
        'response', v_default_response,
        'http_response', v_default_response,
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

    IF NOT v_should_run_workflow THEN
        UPDATE webhook_inbox
        SET processing_status = 'failed',
            processed_at = now(),
            error_message = v_response_reason,
            updated_at = now()
        WHERE id = v_webhook_id;

        v_response_status := GREATEST(v_response_status, v_status_bad);
        v_response_outcome := 'response_failed';
        v_response_reason := COALESCE(v_response_reason, 'workflow_disabled');
    ELSE
        v_workflow_run_id := start_workflow_run(v_intake_template_id, v_run_context);

        UPDATE webhook_inbox
        SET workflow_run_id = v_workflow_run_id,
            processing_status = 'in_progress',
            updated_at = now()
        WHERE id = v_webhook_id;
    END IF;

    LOOP
        EXIT WHEN NOT v_should_poll;
        EXIT WHEN v_loop_count >= v_poll_attempts;
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
            PERFORM pg_sleep(v_poll_interval_ms::NUMERIC / 1000);
        END IF;
    END LOOP;

    IF v_progress ? 'followup_workflow_run_id' THEN
        v_followup_run_id := COALESCE(
            v_followup_run_id,
            NULLIF(v_progress->>'followup_workflow_run_id', '')::UUID
        );
    END IF;

    IF v_response_headers IS NULL OR v_response_headers::TEXT = 'null' THEN
        v_response_headers := '{}'::jsonb;
    END IF;

    IF NOT v_response_headers ? 'content-type' THEN
        v_response_headers := v_response_headers || jsonb_build_object('content-type', 'application/json');
    END IF;

    v_processing_ms := GREATEST(
        0,
        (EXTRACT(EPOCH FROM clock_timestamp() - v_started) * 1000)::INT
    );

    IF v_response_body IS NULL OR v_response_body::TEXT = 'null' THEN
        IF v_response_outcome = 'response_failed' THEN
            v_response_status := v_status_error;
            v_response_body := jsonb_build_object('error', COALESCE(v_response_reason, 'Webhook response failed'));
        ELSIF v_response_mode = 'accepted_async' THEN
            v_response_status := v_status_async;
            v_response_body := jsonb_strip_nulls(jsonb_build_object(
                'status', 'accepted_async',
                'correlation_id', v_correlation_id
            ));
        ELSE
            v_response_status := COALESCE(v_response_status, v_status_sync);
            v_response_body := jsonb_build_object('status', 'accepted');
        END IF;
    END IF;

    v_policy_workflow := COALESCE(v_run_context->'workflow', '{}'::jsonb);
    IF v_followup_run_id IS NULL THEN
        v_followup_template_id := NULLIF(v_policy_workflow->>'template_id', '')::UUID;
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

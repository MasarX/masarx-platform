-- Migration: Move webhook HTTP responses to decision_log event model
-- Date: 2025-11-20 19:35 UTC

BEGIN;

-------------------------------------------------------------------------------
-- 1. Normalize existing decision categories and drop redundant artifacts
-------------------------------------------------------------------------------

UPDATE decision_log
SET decision_category = 'http_response_emitted'
WHERE decision_category IN ('webhook_http_response', 'webhook_ack')
  AND resource_type = 'webhook_inbox';

DROP VIEW IF EXISTS webhook_response_latest;
DROP VIEW IF EXISTS webhook_response_events;
DROP VIEW IF EXISTS observability_events_v;
DROP TABLE IF EXISTS webhook_response_history;

-------------------------------------------------------------------------------
-- 2. Projection views backed by decision_log
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW webhook_response_events AS
SELECT
    dl.id AS decision_log_id,
    dl.resource_id AS webhook_inbox_id,
    dl.organization_id,
    dl.decision_outcome AS response_outcome,
    dl.decision_reason AS response_reason,
    COALESCE(dl.decision_inputs->>'mode', 'accepted_async') AS response_mode,
    NULLIF(dl.decision_inputs->>'status', '')::INT AS http_status_code,
    dl.decision_inputs->'headers' AS http_headers,
    dl.decision_inputs->'body' AS http_body,
    COALESCE(dl.decision_inputs->'validation_results', '{}'::jsonb) AS validation_results,
    NULLIF(dl.decision_inputs->>'idempotency_key', '') AS idempotency_key,
    NULLIF(dl.decision_inputs->>'workflow_run_id', '')::UUID AS workflow_run_id,
    NULLIF(dl.decision_inputs->>'workflow_run_step_id', '')::UUID AS workflow_run_step_id,
    NULLIF(dl.decision_inputs->>'followup_workflow_run_id', '')::UUID AS followup_workflow_run_id,
    dl.timestamp AS response_created_at
FROM decision_log dl
WHERE dl.resource_type = 'webhook_inbox'
  AND dl.decision_category = 'http_response_emitted';

COMMENT ON VIEW webhook_response_events
    IS 'Event stream of webhook HTTP responses sourced from decision_log (single source of truth).';

CREATE OR REPLACE VIEW webhook_response_latest AS
SELECT
    e.decision_log_id,
    e.webhook_inbox_id,
    e.organization_id,
    e.response_outcome,
    e.response_reason,
    e.response_mode,
    e.http_status_code,
    e.http_headers,
    e.http_body,
    e.validation_results,
    e.idempotency_key,
    e.workflow_run_id,
    e.workflow_run_step_id,
    e.followup_workflow_run_id,
    e.response_created_at
FROM (
    SELECT
        we.*,
        ROW_NUMBER() OVER (
            PARTITION BY we.webhook_inbox_id
            ORDER BY we.response_created_at DESC, we.decision_log_id DESC
        ) AS row_rank
    FROM webhook_response_events we
) e
WHERE e.row_rank = 1;

COMMENT ON VIEW webhook_response_latest
    IS 'Latest webhook HTTP response per inbox row (decision_log projection).';

-- Recreate observability view against decision_log-backed response events.
CREATE OR REPLACE VIEW observability_events_v AS
WITH outbound_org AS (
    SELECT
        oc.id,
        COALESCE(
            s.organization_id,
            NULLIF(oc.context ->> 'organization_id', '')::uuid
        ) AS organization_id
    FROM outbound_calls oc
    LEFT JOIN shipments s ON s.id = oc.shipment_id
)
SELECT
    dl.id AS event_id,
    dl.organization_id,
    'decision_log'::text AS event_source,
    dl.decision_category AS event_type,
    dl.resource_type,
    dl.resource_id,
    dl.correlation_id,
    dl.decision_outcome AS status,
    dl.timestamp AS event_time,
    jsonb_strip_nulls(jsonb_build_object(
        'decision_point', dl.decision_point,
        'decision_reason', dl.decision_reason,
        'performed_by', dl.performed_by_system,
        'settings_resolution_id', dl.settings_resolution_id,
        'decision_inputs', dl.decision_inputs
    )) AS metadata
FROM decision_log dl

UNION ALL

SELECT
    acl.id AS event_id,
    acl.organization_id,
    'api_call_log'::text AS event_source,
    acl.operation AS event_type,
    'api_call'::text AS resource_type,
    acl.provider_id AS resource_id,
    NULL::uuid AS correlation_id,
    CASE
        WHEN acl.response_status BETWEEN 200 AND 299 THEN 'succeeded'
        WHEN acl.response_status IS NULL THEN 'unknown'
        ELSE 'failed'
    END AS status,
    acl.timestamp AS event_time,
    jsonb_strip_nulls(jsonb_build_object(
        'method', acl.method,
        'url', acl.url,
        'response_status', acl.response_status,
        'duration_ms', acl.duration_ms,
        'error_message', acl.error_message,
        'circuit_breaker_state', acl.circuit_breaker_state
    )) AS metadata
FROM api_call_log acl

UNION ALL

SELECT
    we.decision_log_id AS event_id,
    COALESCE(we.organization_id, dl.organization_id) AS organization_id,
    'webhook_http_response'::text AS event_source,
    COALESCE(we.response_outcome, 'response_sent') AS event_type,
    'webhook'::text AS resource_type,
    we.webhook_inbox_id AS resource_id,
    dl.correlation_id,
    COALESCE(we.response_outcome, 'unknown') AS status,
    we.response_created_at AS event_time,
    jsonb_strip_nulls(jsonb_build_object(
        'http_status_code', we.http_status_code,
        'response_mode', we.response_mode,
        'response_reason', we.response_reason,
        'workflow_run_id', we.workflow_run_id,
        'workflow_run_step_id', we.workflow_run_step_id,
        'followup_workflow_run_id', we.followup_workflow_run_id,
        'validation_results', we.validation_results,
        'idempotency_key', we.idempotency_key
    )) AS metadata
FROM webhook_response_events we
JOIN decision_log dl ON dl.id = we.decision_log_id

UNION ALL

SELECT
    oc.id AS event_id,
    outbound_org.organization_id,
    'outbound_calls'::text AS event_source,
    oc.call_type AS event_type,
    oc.target_type AS resource_type,
    oc.target_id AS resource_id,
    oc.correlation_id,
    oc.status,
    COALESCE(oc.completed_at, oc.created_at) AS event_time,
    jsonb_strip_nulls(jsonb_build_object(
        'method', oc.method,
        'url', oc.url,
        'response_status_code', oc.response_status_code,
        'error_message', oc.error_message,
        'latency_ms', oc.latency_ms,
        'priority', oc.priority,
        'workflow_run_step_id', oc.workflow_run_step_id
    )) AS metadata
FROM outbound_calls oc
LEFT JOIN outbound_org ON outbound_org.id = oc.id;

COMMENT ON VIEW observability_events_v IS
    'Unified observability view (decision_log, api_call_log, webhook_http_response, outbound_calls) exposing event_id, scope, status, and metadata for incident triage.';

-------------------------------------------------------------------------------
-- 3. Indexes to accelerate response lookups and idempotency replay
-------------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_decision_log_http_response
    ON decision_log (resource_type, resource_id, timestamp DESC)
    WHERE decision_category = 'http_response_emitted';

CREATE INDEX IF NOT EXISTS idx_decision_log_http_response_idempotency
    ON decision_log ((decision_inputs->>'idempotency_key'))
    WHERE decision_category = 'http_response_emitted'
      AND resource_type = 'webhook_inbox'
      AND decision_inputs ? 'idempotency_key';

-------------------------------------------------------------------------------
-- 4. Update HTTP response persistence handler to emit decision_log events only
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.persist_http_response_v1(
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
    v_http JSONB := COALESCE(v_context->'http_response', '{}'::jsonb);
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
    v_decision_point TEXT := COALESCE(
        NULLIF(v_context->>'response_decision_point', ''),
        'workflow_intake_response'
    );
    v_mode TEXT := COALESCE(NULLIF(v_http->>'mode', ''), 'accepted_async');
    v_status INT := COALESCE((v_http->>'status')::INT, CASE WHEN v_mode = 'accepted_async' THEN 202 ELSE 200 END);
    v_headers_final JSONB := jsonb_strip_nulls(COALESCE(v_http->'headers', '{}'::jsonb));
    v_body JSONB := v_http->'body';
    v_outcome TEXT := COALESCE(NULLIF(v_http->>'outcome', ''), 'response_sent');
    v_reason TEXT := NULLIF(v_http->>'reason', '');
    v_followup_id UUID := NULLIF(v_context->>'followup_workflow_run_id', '')::UUID;
    v_sent_at TIMESTAMPTZ := now();
    v_decision_inputs JSONB;
    v_decision_id UUID;
    v_result workflow_handler_response;
    v_response_projection JSONB;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    IF v_webhook_id IS NULL OR v_source_id IS NULL THEN
        RAISE EXCEPTION 'persist_http_response_v1: webhook_id (%) and webhook_source_id (%) required', v_webhook_id, v_source_id;
    END IF;

    IF v_headers_final IS NULL OR v_headers_final::TEXT = 'null' THEN
        v_headers_final := '{}'::jsonb;
    END IF;

    IF NOT (v_headers_final ? 'content-type') THEN
        v_headers_final := v_headers_final || jsonb_build_object('content-type', 'application/json');
    END IF;

    IF v_body IS NULL OR v_body::TEXT = 'null' THEN
        IF v_outcome = 'response_failed' THEN
            v_body := jsonb_build_object('error', COALESCE(v_reason, 'Webhook response failed'));
        ELSIF v_mode = 'accepted_async' THEN
            v_body := jsonb_strip_nulls(jsonb_build_object(
                'status', 'accepted_async',
                'correlation_id', v_context->>'correlation_id'
            ));
        ELSE
            v_body := jsonb_build_object('status', 'accepted');
        END IF;
    END IF;

    IF v_outcome = 'response_failed' THEN
        v_status := GREATEST(v_status, 400);
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
    SET
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
        updated_at = v_sent_at
    WHERE id = v_webhook_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'persist_http_response_v1: webhook inbox % missing', v_webhook_id;
    END IF;

    v_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'status', v_status,
        'headers', v_headers_final,
        'body', v_body,
        'mode', v_mode,
        'validation_results', COALESCE(v_validation, '{}'::jsonb),
        'idempotency_key', v_idempotency_key,
        'workflow_run_id', p_run.id,
        'workflow_run_step_id', p_step.id,
        'followup_workflow_run_id', v_followup_id
    ));

    v_decision_id := log_decision(
        p_organization_id := v_organization_id,
        p_decision_category := 'http_response_emitted',
        p_resource_type := 'webhook_inbox',
        p_resource_id := v_webhook_id,
        p_decision_point := v_decision_point,
        p_decision_outcome := v_outcome,
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := v_decision_inputs,
        p_decision_reason := v_reason
    );

    v_response_projection := jsonb_strip_nulls(jsonb_build_object(
        'status', v_status,
        'headers', v_headers_final,
        'body', v_body,
        'mode', v_mode,
        'outcome', v_outcome,
        'reason', v_reason,
        'decision_log_id', v_decision_id,
        'sent_at', v_sent_at
    ));

    v_result.status := 'completed';
    v_result.operation_result := v_response_projection;
    v_result.context_patch := jsonb_strip_nulls(
        COALESCE(v_result.context_patch, '{}'::jsonb) ||
        jsonb_build_object('http_response', v_response_projection)
    );

    RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.persist_http_response_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Persist webhook HTTP response by emitting a decision_log event (single source of truth).';

-------------------------------------------------------------------------------
-- 5. Align intake RPC with event-backed projections
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
    v_progress JSONB;
    v_run_state JSONB;
    v_loop_count INT := 0;
    v_processing_ms INT := 0;
    v_started TIMESTAMPTZ := clock_timestamp();
    v_http_response JSONB := '{}'::jsonb;
    v_payload_for_db JSONB;
    v_should_run_workflow BOOLEAN := TRUE;
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

    v_response_mode := COALESCE(v_policy_body->'response'->>'mode', v_policy_body->'ack'->>'mode', 'accepted_async');
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
    IS 'Start webhook intake workflow and return workflow-computed HTTP response (decision_log backed).';

COMMIT;

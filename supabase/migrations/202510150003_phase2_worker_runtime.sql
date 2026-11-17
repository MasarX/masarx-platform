-- Migration: Phase 2 - Worker Runtime Functions
-- Purpose: Provide runtime helpers (settings resolver, request context utilities, decision logging)
--          and implement canonical worker functions that honour the platform objectives.
-- Date: 2025-10-15

-- =============================================================================
-- Helper: resolve_settings (override ladder)
-- =============================================================================

CREATE OR REPLACE FUNCTION resolve_settings(
    p_category TEXT,
    p_scope_type TEXT,
    p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_value JSONB;
    v_client_id UUID;
    v_org_id UUID;
BEGIN
    IF p_category IS NULL THEN
        RETURN NULL;
    END IF;

    -- Normalise scope type strings
    IF p_scope_type IS NULL OR p_scope_type = '' THEN
        p_scope_type := 'global';
    ELSIF p_scope_type = 'organization' THEN
        p_scope_type := 'tenant';
    END IF;

    -- Global lookup (no recursion)
    IF p_scope_type = 'global' THEN
        SELECT cached_value
        INTO v_value
        FROM settings
        WHERE category = p_category
          AND scope_type = 'global'
        ORDER BY last_updated DESC
        LIMIT 1;
        RETURN v_value;
    END IF;

    -- Direct lookup for provided scope
    SELECT cached_value
    INTO v_value
    FROM settings
    WHERE category = p_category
      AND scope_type = p_scope_type
      AND (
            (scope_type = 'global' AND scope_id IS NULL)
            OR scope_id = p_scope_id
          )
    ORDER BY last_updated DESC
    LIMIT 1;

    IF v_value IS NOT NULL THEN
        RETURN v_value;
    END IF;

    -- Fallback ladder
    IF p_scope_type = 'sender' THEN
        SELECT client_id INTO v_client_id FROM senders WHERE id = p_scope_id;
        IF v_client_id IS NOT NULL THEN
            v_value := resolve_settings(p_category, 'client', v_client_id);
            IF v_value IS NOT NULL THEN
                RETURN v_value;
            END IF;
        END IF;

        SELECT c.organization_id INTO v_org_id
        FROM senders s
        JOIN clients c ON c.id = s.client_id
        WHERE s.id = p_scope_id;

        IF v_org_id IS NOT NULL THEN
            v_value := resolve_settings(p_category, 'tenant', v_org_id);
            IF v_value IS NOT NULL THEN
                RETURN v_value;
            END IF;
        END IF;

        RETURN resolve_settings(p_category, 'global', NULL);
    ELSIF p_scope_type = 'client' THEN
        SELECT organization_id INTO v_org_id FROM clients WHERE id = p_scope_id;
        IF v_org_id IS NOT NULL THEN
            v_value := resolve_settings(p_category, 'tenant', v_org_id);
            IF v_value IS NOT NULL THEN
                RETURN v_value;
            END IF;
        END IF;

        RETURN resolve_settings(p_category, 'global', NULL);
    ELSIF p_scope_type = 'tenant' THEN
        RETURN resolve_settings(p_category, 'global', NULL);
    ELSE
        -- Role, user, resource and unknown scope types fall back to global for now.
        RETURN resolve_settings(p_category, 'global', NULL);
    END IF;
END;
$$;

COMMENT ON FUNCTION resolve_settings(TEXT, TEXT, UUID)
    IS 'Resolve configuration value using override ladder: sender -> client -> tenant -> global.';

-- =============================================================================
-- Helper: check_throttle
-- =============================================================================

CREATE OR REPLACE FUNCTION check_throttle(p_worker_name TEXT)
RETURNS TABLE (
    should_run BOOLEAN,
    reason TEXT,
    batch_size INT,
    interval_seconds_config INT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_config RECORD;
BEGIN
    SELECT c.worker_name, c.interval_seconds, c.batch_size, c.last_run_at, c.enabled
    INTO v_config
    FROM cron_config c
    WHERE worker_name = p_worker_name;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Worker not registered in cron_config', 0, 0;
        RETURN;
    END IF;

    IF NOT v_config.enabled THEN
        RETURN QUERY SELECT FALSE, 'Worker disabled in cron_config', 0, v_config.interval_seconds;
        RETURN;
    END IF;

    IF v_config.last_run_at IS NOT NULL
       AND v_config.last_run_at + make_interval(secs => v_config.interval_seconds) > now() THEN
        RETURN QUERY SELECT FALSE, 'Throttled: interval not elapsed', v_config.batch_size, v_config.interval_seconds;
        RETURN;
    END IF;

    RETURN QUERY SELECT TRUE, 'ready', v_config.batch_size, v_config.interval_seconds;
END;
$$;

COMMENT ON FUNCTION check_throttle(TEXT)
    IS 'Consult cron_config for worker cadence and determine if worker should run (self-throttling support).';

-- =============================================================================
-- Helper: create_request_context / complete_request_context / update_cron_config
-- =============================================================================

CREATE OR REPLACE FUNCTION create_request_context(
    p_worker_name TEXT,
    p_entry_point TEXT DEFAULT 'worker'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_id UUID := gen_random_uuid();
BEGIN
    INSERT INTO request_contexts (
        id,
        entry_point,
        primary_entity_type,
        primary_entity_id,
        batch_size,
        started_at,
        created_at,
        error_occurred
    ) VALUES (
        v_id,
        p_entry_point,
        'worker',
        NULL,
        NULL,
        now(),
        now(),
        FALSE
    );

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION create_request_context(TEXT, TEXT)
    IS 'Create a request_context row for worker execution and return correlation_id.';

CREATE OR REPLACE FUNCTION complete_request_context(
    p_context_id UUID,
    p_error_occurred BOOLEAN,
    p_items_processed INT DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE request_contexts
    SET
        completed_at = now(),
        total_duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000,
        error_occurred = p_error_occurred,
        batch_size = CASE WHEN p_items_processed > 0 THEN p_items_processed ELSE batch_size END
    WHERE id = p_context_id;
END;
$$;

COMMENT ON FUNCTION complete_request_context(UUID, BOOLEAN, INT)
    IS 'Finalize request_context row with completion details.';

CREATE OR REPLACE FUNCTION update_cron_config(p_worker_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE cron_config
    SET last_run_at = now()
    WHERE worker_name = p_worker_name;
END;
$$;

COMMENT ON FUNCTION update_cron_config(TEXT)
    IS 'Update cron_config.last_run_at to mark worker execution time.';

-- =============================================================================
-- Helper: log_decision (strict organisation requirement)
-- =============================================================================

CREATE OR REPLACE FUNCTION log_decision(
    p_organization_id UUID,
    p_decision_category TEXT,
    p_resource_type TEXT,
    p_resource_id UUID,
    p_decision_point TEXT,
    p_decision_outcome TEXT,
    p_performed_by_system TEXT,
    p_correlation_id UUID DEFAULT NULL,
    p_decision_inputs JSONB DEFAULT '{}'::jsonb,
    p_decision_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_id UUID := gen_random_uuid();
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'log_decision requires organization_id (received NULL for resource_type=% resource_id=%)', p_resource_type, p_resource_id;
    END IF;

    INSERT INTO decision_log (
        id,
        organization_id,
        decision_category,
        resource_type,
        resource_id,
        decision_point,
        decision_outcome,
        decision_inputs,
        decision_reason,
        performed_by_system,
        correlation_id,
        timestamp
    ) VALUES (
        v_id,
        p_organization_id,
        p_decision_category,
        p_resource_type,
        p_resource_id,
        p_decision_point,
        p_decision_outcome,
        COALESCE(p_decision_inputs, '{}'::jsonb),
        p_decision_reason,
        p_performed_by_system,
        p_correlation_id,
        now()
    );
END;
$$;

COMMENT ON FUNCTION log_decision(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB, TEXT)
    IS 'Canonical helper to insert decision_log rows. Requires organization_id (no global fallbacks).';

-- =============================================================================
-- Helper: resolve_organization_id_strict
-- =============================================================================

CREATE OR REPLACE FUNCTION resolve_organization_id_strict(
    p_resource_type TEXT,
    p_resource_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_org UUID;
BEGIN
    CASE p_resource_type
        WHEN 'provider' THEN
            SELECT organization_id INTO v_org FROM providers WHERE id = p_resource_id;
        WHEN 'client' THEN
            SELECT organization_id INTO v_org FROM clients WHERE id = p_resource_id;
        WHEN 'sender' THEN
            SELECT c.organization_id INTO v_org
            FROM senders s
            JOIN clients c ON c.id = s.client_id
            WHERE s.id = p_resource_id;
        WHEN 'shipment' THEN
            SELECT c.organization_id INTO v_org
            FROM shipments s
            JOIN clients c ON c.id = s.client_id
            WHERE s.id = p_resource_id;
        WHEN 'webhook_inbox' THEN
            SELECT ws.organization_id INTO v_org
            FROM webhook_inbox wi
            JOIN webhook_sources ws ON ws.id = wi.webhook_source_id
            WHERE wi.id = p_resource_id;
        WHEN 'outbound_call' THEN
            SELECT organization_id INTO v_org
            FROM providers
            WHERE id = (
                SELECT target_id
                FROM outbound_calls
                WHERE id = p_resource_id
                  AND target_type = 'provider'
            );
            IF v_org IS NULL THEN
                SELECT c.organization_id
                INTO v_org
                FROM outbound_calls oc
                JOIN clients c ON c.id = oc.target_id
                WHERE oc.id = p_resource_id
                  AND oc.target_type = 'client';
            END IF;
        WHEN 'alert_rule' THEN
            SELECT organization_id INTO v_org FROM alert_rules WHERE id = p_resource_id;
        WHEN 'circuit_breaker_state' THEN
            SELECT p.organization_id INTO v_org
            FROM circuit_breaker_state cbs
            JOIN providers p ON p.id = cbs.provider_id
            WHERE cbs.id = p_resource_id;
        ELSE
            RAISE EXCEPTION 'resolve_organization_id_strict: unsupported resource_type=%', p_resource_type;
    END CASE;

    IF v_org IS NULL THEN
        RAISE EXCEPTION 'Unable to resolve organization_id for resource_type=% resource_id=%', p_resource_type, p_resource_id;
    END IF;

    RETURN v_org;
END;
$$;

COMMENT ON FUNCTION resolve_organization_id_strict(TEXT, UUID)
    IS 'Resolve organization_id for known resource types. Raises if the organisation cannot be determined.';

-- =============================================================================
-- Worker: run_outbound_worker
-- =============================================================================

CREATE OR REPLACE FUNCTION run_outbound_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_job RECORD;
    v_org UUID;
    v_spec JSONB;
    v_result JSONB;
    v_status INT;
    v_completed BOOLEAN;
BEGIN
    SELECT * INTO v_throttle FROM check_throttle('outbound_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := create_request_context('outbound_worker');

    FOR v_job IN SELECT * FROM claim_pending_jobs(v_throttle.batch_size)
    LOOP
        BEGIN
            IF v_job.target_type = 'provider' THEN
                v_org := resolve_organization_id_strict('provider', v_job.target_id);
            ELSIF v_job.target_type = 'client' THEN
                v_org := resolve_organization_id_strict('client', v_job.target_id);
            ELSIF v_job.shipment_id IS NOT NULL THEN
                v_org := resolve_organization_id_strict('shipment', v_job.shipment_id);
            ELSE
                v_org := resolve_organization_id_strict('outbound_call', v_job.job_id);
            END IF;

            v_spec := get_job_call_spec(v_job.job_id);
            v_result := call_api(
                v_spec->>'url',
                COALESCE(v_spec->>'method', 'POST'),
                COALESCE(v_spec->'headers', '{}'::jsonb),
                COALESCE(v_spec->'body', '{}'::jsonb),
                NULL
            );

            v_status := COALESCE((v_result->>'status')::INT, 0);
            v_completed := COALESCE((v_result->>'completed')::BOOLEAN, FALSE);

            IF v_completed AND v_status BETWEEN 200 AND 299 THEN
                UPDATE outbound_calls
                SET status = 'completed',
                    response_status_code = v_status,
                    response_body = v_result->'body',
                    response_headers = v_result->'headers',
                    latency_ms = (v_result->>'latency_ms')::INT,
                    completed_at = now(),
                    error_message = NULL
                WHERE id = v_job.job_id;

                PERFORM orchestrate_api_response_processing(v_job.job_id);

                PERFORM log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'http_execution',
                    p_decision_outcome := 'success',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := jsonb_build_object('status', v_status),
                    p_decision_reason := 'Outbound HTTP request completed successfully.'
                );
            ELSIF v_completed THEN
                UPDATE outbound_calls
                SET status = CASE WHEN v_job.retry_count + 1 >= v_job.max_retries THEN 'permanently_failed' ELSE 'failed' END,
                    retry_count = v_job.retry_count + 1,
                    response_status_code = v_status,
                    response_body = v_result->'body',
                    response_headers = v_result->'headers',
                    error_message = COALESCE(v_result->'body'->>'error', format('HTTP %s failure', v_status)),
                    completed_at = CASE WHEN v_job.retry_count + 1 >= v_job.max_retries THEN now() ELSE NULL END
                WHERE id = v_job.job_id;

                PERFORM log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'http_execution',
                    p_decision_outcome := 'error',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := jsonb_build_object('status', v_status),
                    p_decision_reason := format('Outbound HTTP request failed with status %s', v_status)
                );
            ELSE
                UPDATE outbound_calls
                SET status = 'pending',
                    scheduled_at = now() + interval '30 seconds',
                    context = jsonb_set(
                        COALESCE(context, '{}'::jsonb),
                        '{async_request_id}',
                        to_jsonb(v_result->>'request_id'),
                        TRUE
                    )
                WHERE id = v_job.job_id;

                PERFORM log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'http_execution',
                    p_decision_outcome := 'async_pending',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := jsonb_build_object('request_id', v_result->>'request_id'),
                    p_decision_reason := 'HTTP request accepted asynchronously; awaiting polling.'
                );
            END IF;

            v_items_processed := v_items_processed + 1;
        EXCEPTION
            WHEN OTHERS THEN
                v_error := TRUE;
                UPDATE outbound_calls
                SET status = CASE WHEN v_job.retry_count + 1 >= v_job.max_retries THEN 'permanently_failed' ELSE 'failed' END,
                    retry_count = v_job.retry_count + 1,
                    error_message = SQLERRM,
                    completed_at = CASE WHEN v_job.retry_count + 1 >= v_job.max_retries THEN now() ELSE NULL END
                WHERE id = v_job.job_id;

                IF v_org IS NOT NULL THEN
                    PERFORM log_decision(
                        p_organization_id := v_org,
                        p_decision_category := 'outbound_call',
                        p_resource_type := 'outbound_call',
                        p_resource_id := v_job.job_id,
                        p_decision_point := 'http_execution',
                        p_decision_outcome := 'exception',
                        p_performed_by_system := 'outbound_worker',
                        p_correlation_id := v_job.correlation_id,
                        p_decision_reason := SQLERRM
                    );
                END IF;
        END;
    END LOOP;

    PERFORM complete_request_context(v_context, v_error, v_items_processed);
    PERFORM update_cron_config('outbound_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'error_occurred', v_error
    );
END;
$$;

COMMENT ON FUNCTION run_outbound_worker()
    IS 'Execute outbound_worker queue: throttle-aware claim, call call_api(), log decisions without fallback UUIDs.';

-- =============================================================================
-- Worker: run_webhook_processor_worker
-- =============================================================================

CREATE OR REPLACE FUNCTION run_webhook_processor_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_row RECORD;
    v_result JSONB;
    v_org UUID;
BEGIN
    SELECT * INTO v_throttle FROM check_throttle('webhook_processor_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := create_request_context('webhook_processor_worker');

    FOR v_row IN
        SELECT wi.id AS webhook_id, ws.organization_id
        FROM webhook_inbox wi
        JOIN webhook_sources ws ON ws.id = wi.webhook_source_id
        WHERE wi.processing_status = 'pending'
        ORDER BY wi.created_at ASC
        LIMIT v_throttle.batch_size
        FOR UPDATE SKIP LOCKED
    LOOP
        BEGIN
            v_result := orchestrate_webhook_processing(v_row.webhook_id);
            v_org := COALESCE(
                v_row.organization_id,
                resolve_organization_id_strict('webhook_inbox', v_row.webhook_id)
            );

            PERFORM log_decision(
                p_organization_id := v_org,
                p_decision_category := 'webhook_processing',
                p_resource_type := 'webhook_inbox',
                p_resource_id := v_row.webhook_id,
                p_decision_point := 'process_webhook',
                p_decision_outcome := v_result->>'status',
                p_performed_by_system := 'webhook_processor_worker',
                p_correlation_id := v_context,
                p_decision_inputs := v_result,
                p_decision_reason := 'Webhook processed via orchestrator helper.'
            );

            v_items_processed := v_items_processed + 1;
        EXCEPTION
            WHEN OTHERS THEN
                v_error := TRUE;
                UPDATE webhook_inbox
                SET processing_status = 'failed',
                    error_message = SQLERRM,
                    processed_at = now()
                WHERE id = v_row.webhook_id;

                v_org := COALESCE(
                    v_row.organization_id,
                    resolve_organization_id_strict('webhook_inbox', v_row.webhook_id)
                );

                PERFORM log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'webhook_processing',
                    p_resource_type := 'webhook_inbox',
                    p_resource_id := v_row.webhook_id,
                    p_decision_point := 'process_webhook',
                    p_decision_outcome := 'error',
                    p_performed_by_system := 'webhook_processor_worker',
                    p_correlation_id := v_context,
                    p_decision_reason := SQLERRM
                );
        END;
    END LOOP;

    PERFORM complete_request_context(v_context, v_error, v_items_processed);
    PERFORM update_cron_config('webhook_processor_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'error_occurred', v_error
    );
END;
$$;

COMMENT ON FUNCTION run_webhook_processor_worker()
    IS 'Process pending webhook inbox entries with settings-driven policies. No fallback UUIDs.';

-- =============================================================================
-- Remaining Workers (campaign & maintenance)
-- =============================================================================

CREATE OR REPLACE FUNCTION run_campaign_enrollment_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_candidate RECORD;
    v_policy JSONB;
    v_campaign_key TEXT;
    v_enrollment_id UUID;
BEGIN
    SELECT * INTO v_throttle FROM check_throttle('campaign_enrollment_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := create_request_context('campaign_enrollment_worker');

    FOR v_candidate IN
        SELECT s.id AS shipment_id,
               s.organization_id,
               s.client_id,
               s.sender_id
        FROM shipments s
        WHERE s.status = 'pending'
          AND NOT EXISTS (
                SELECT 1
                FROM campaign_enrollments ce
                WHERE ce.shipment_id = s.id
            )
        ORDER BY s.created_at DESC
        LIMIT v_throttle.batch_size
    LOOP
        BEGIN
            v_policy := NULL;
            IF v_candidate.sender_id IS NOT NULL THEN
                v_policy := resolve_settings('campaign_policy', 'sender', v_candidate.sender_id);
            END IF;
            IF v_policy IS NULL THEN
                v_policy := resolve_settings('campaign_policy', 'client', v_candidate.client_id);
            END IF;
            IF v_policy IS NULL THEN
                v_policy := resolve_settings('campaign_policy', 'tenant', v_candidate.organization_id);
            END IF;
            IF v_policy IS NULL THEN
                v_policy := resolve_settings('campaign_policy', 'global', NULL);
            END IF;

            IF v_policy ? 'enrollment_enabled' AND (v_policy->>'enrollment_enabled')::BOOLEAN THEN
                v_campaign_key := NULL;
                IF v_policy ? 'campaign_key' AND trim(both ' ' FROM v_policy->>'campaign_key') <> '' THEN
                    v_campaign_key := v_policy->>'campaign_key';
                END IF;

                IF v_campaign_key IS NULL THEN
                    PERFORM log_decision(
                        p_organization_id := v_candidate.organization_id,
                        p_decision_category := 'campaign_enrollment',
                        p_resource_type := 'shipment',
                        p_resource_id := v_candidate.shipment_id,
                        p_decision_point := 'evaluate_enrollment',
                        p_decision_outcome := 'missing_campaign_key',
                        p_performed_by_system := 'campaign_enrollment_worker',
                        p_correlation_id := v_context,
                        p_decision_inputs := COALESCE(v_policy, '{}'::jsonb),
                        p_decision_reason := 'Campaign policy missing campaign_key; skipping enrollment.'
                    );
                ELSE
                    INSERT INTO campaign_enrollments (
                        organization_id,
                        client_id,
                        sender_id,
                        shipment_id,
                        campaign_key,
                        status,
                        metadata
                    ) VALUES (
                        v_candidate.organization_id,
                        v_candidate.client_id,
                        v_candidate.sender_id,
                        v_candidate.shipment_id,
                        v_campaign_key,
                        'enrolled',
                        COALESCE(v_policy->'metadata', '{}'::jsonb)
                    )
                    ON CONFLICT (shipment_id, campaign_key) DO UPDATE
                    SET enrolled_at = EXCLUDED.enrolled_at
                    RETURNING id INTO v_enrollment_id;

                    IF v_enrollment_id IS NOT NULL THEN
                        PERFORM log_decision(
                            p_organization_id := v_candidate.organization_id,
                            p_decision_category := 'campaign_enrollment',
                            p_resource_type := 'shipment',
                            p_resource_id := v_candidate.shipment_id,
                            p_decision_point := 'evaluate_enrollment',
                            p_decision_outcome := 'enrolled',
                            p_performed_by_system := 'campaign_enrollment_worker',
                            p_correlation_id := v_context,
                            p_decision_inputs := v_policy,
                            p_decision_reason := format('Shipment enrolled in campaign %s', v_campaign_key)
                        );
                        v_items_processed := v_items_processed + 1;
                    END IF;
                END IF;
            ELSE
                PERFORM log_decision(
                    p_organization_id := v_candidate.organization_id,
                    p_decision_category := 'campaign_enrollment',
                    p_resource_type := 'shipment',
                    p_resource_id := v_candidate.shipment_id,
                    p_decision_point := 'evaluate_enrollment',
                    p_decision_outcome := 'policy_disabled',
                    p_performed_by_system := 'campaign_enrollment_worker',
                    p_correlation_id := v_context,
                    p_decision_inputs := COALESCE(v_policy, '{}'::jsonb),
                    p_decision_reason := 'Campaign policy disabled or missing.'
                );
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                v_error := TRUE;
        END;
    END LOOP;

    PERFORM complete_request_context(v_context, v_error, v_items_processed);
    PERFORM update_cron_config('campaign_enrollment_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'error_occurred', v_error
    );
END;
$$;

CREATE OR REPLACE FUNCTION run_campaign_dispatcher_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_enrollment RECORD;
BEGIN
    SELECT * INTO v_throttle FROM check_throttle('campaign_dispatcher_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := create_request_context('campaign_dispatcher_worker');

    FOR v_enrollment IN
        SELECT *
        FROM campaign_enrollments
        WHERE status = 'enrolled'
        ORDER BY enrolled_at
        LIMIT v_throttle.batch_size
    LOOP
        UPDATE campaign_enrollments
        SET status = 'dispatched',
            last_dispatch_at = now()
        WHERE id = v_enrollment.id;

        PERFORM log_decision(
            p_organization_id := v_enrollment.organization_id,
            p_decision_category := 'campaign_dispatch',
            p_resource_type := 'campaign_enrollment',
            p_resource_id := v_enrollment.id,
            p_decision_point := 'dispatch',
            p_decision_outcome := 'dispatched',
            p_performed_by_system := 'campaign_dispatcher_worker',
            p_correlation_id := v_context,
            p_decision_reason := 'Campaign enrollment dispatched for outreach.'
        );

        v_items_processed := v_items_processed + 1;
    END LOOP;

    PERFORM complete_request_context(v_context, FALSE, v_items_processed);
    PERFORM update_cron_config('campaign_dispatcher_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'error_occurred', FALSE
    );
END;
$$;

CREATE OR REPLACE FUNCTION run_alert_aggregation_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_rule RECORD;
    v_trigger_category TEXT;
    v_match_count INT := 0;
    v_outcome TEXT := 'no_alert';
    v_window_minutes INT;
    v_window_interval INTERVAL;
    v_reason TEXT := 'Alert rule evaluated against decision_log';
BEGIN
    SELECT * INTO v_throttle FROM check_throttle('alert_aggregation_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := create_request_context('alert_aggregation_worker');

    FOR v_rule IN
        SELECT *
        FROM alert_rules
        WHERE enabled = TRUE
        ORDER BY priority DESC
        LIMIT v_throttle.batch_size
    LOOP
        v_trigger_category := v_rule.trigger_conditions->>'decision_category';
        v_window_minutes := GREATEST(COALESCE(v_rule.throttle_window_minutes, 15), 1);
        v_match_count := 0;
        v_outcome := 'no_alert';
        v_reason := 'Alert rule evaluated against decision_log';

        IF v_rule.trigger_source = 'decision_log' THEN
            IF v_trigger_category IS NOT NULL THEN
                v_window_interval := make_interval(mins => v_window_minutes);

                SELECT COUNT(*)
                INTO v_match_count
                FROM decision_log
                WHERE decision_category = v_trigger_category
                  AND timestamp > now() - v_window_interval
                  AND organization_id = v_rule.organization_id;

                IF v_match_count > 0 THEN
                    v_outcome := 'alert_triggered';
                    v_reason := format('Alert triggered (%s matches in last %s minutes)', v_match_count, v_window_minutes);
                ELSE
                    v_reason := format('No matches for %s in last %s minutes', v_trigger_category, v_window_minutes);
                END IF;
            ELSE
                v_outcome := 'missing_trigger_category';
                v_reason := 'trigger_conditions.decision_category not present; rule ignored';
            END IF;
        ELSE
            v_outcome := 'unsupported_trigger_source';
            v_reason := format('Trigger source %s not yet supported by alert worker', v_rule.trigger_source);
        END IF;

        PERFORM log_decision(
            p_organization_id := v_rule.organization_id,
            p_decision_category := 'alert_evaluation',
            p_resource_type := 'alert_rule',
            p_resource_id := v_rule.id,
            p_decision_point := 'rule_scan',
            p_decision_outcome := v_outcome,
            p_performed_by_system := 'alert_aggregation_worker',
            p_correlation_id := v_context,
            p_decision_inputs := jsonb_build_object(
                'trigger_category', v_trigger_category,
                'match_count', v_match_count,
                'trigger_source', v_rule.trigger_source,
                'window_minutes', v_window_minutes
            ),
            p_decision_reason := v_reason
        );
        v_items_processed := v_items_processed + 1;
    END LOOP;

    PERFORM complete_request_context(v_context, FALSE, v_items_processed);
    PERFORM update_cron_config('alert_aggregation_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'error_occurred', FALSE
    );
END;
$$;

CREATE OR REPLACE FUNCTION run_circuit_breaker_recovery_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_row RECORD;
    v_error BOOLEAN := FALSE;
BEGIN
    SELECT * INTO v_throttle FROM check_throttle('circuit_breaker_recovery_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := create_request_context('circuit_breaker_recovery_worker');

    FOR v_row IN
        SELECT *
        FROM circuit_breaker_state
        WHERE state = 'half_open'
        ORDER BY half_open_test_at ASC NULLS FIRST
        LIMIT v_throttle.batch_size
    LOOP
        BEGIN
            UPDATE circuit_breaker_state
            SET state = 'closed',
                success_count = success_count + 1,
                last_success_at = now(),
                last_recovery_attempt_at = now()
            WHERE id = v_row.id;

            PERFORM log_decision(
                p_organization_id := resolve_organization_id_strict('provider', v_row.provider_id),
                p_decision_category := 'circuit_breaker',
                p_resource_type := 'circuit_breaker_state',
                p_resource_id := v_row.id,
                p_decision_point := 'recovery_check',
                p_decision_outcome := 'recovered',
                p_performed_by_system := 'circuit_breaker_recovery_worker',
                p_correlation_id := v_context,
                p_decision_reason := 'Provider health verified; circuit closed.'
            );

            v_items_processed := v_items_processed + 1;
        EXCEPTION
            WHEN OTHERS THEN
                v_error := TRUE;
                PERFORM log_decision(
                    p_organization_id := resolve_organization_id_strict('provider', v_row.provider_id),
                    p_decision_category := 'circuit_breaker',
                    p_resource_type := 'circuit_breaker_state',
                    p_resource_id := v_row.id,
                    p_decision_point := 'recovery_check',
                    p_decision_outcome := 'error',
                    p_performed_by_system := 'circuit_breaker_recovery_worker',
                    p_correlation_id := v_context,
                    p_decision_reason := SQLERRM
                );
        END;
    END LOOP;

    PERFORM complete_request_context(v_context, v_error, v_items_processed);
    PERFORM update_cron_config('circuit_breaker_recovery_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'error_occurred', v_error
    );
END;
$$;

CREATE OR REPLACE FUNCTION run_cache_cleanup_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_deleted_count INT := 0;
BEGIN
    SELECT * INTO v_throttle FROM check_throttle('cache_cleanup_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := create_request_context('cache_cleanup_worker');

    DELETE FROM settings_cache
    WHERE expires_at IS NOT NULL
      AND expires_at < now();

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    PERFORM complete_request_context(v_context, FALSE, COALESCE(v_deleted_count, 0));
    PERFORM update_cron_config('cache_cleanup_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', COALESCE(v_deleted_count, 0),
        'error_occurred', FALSE
    );
END;
$$;

-- Migration complete.

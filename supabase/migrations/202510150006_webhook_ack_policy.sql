-- Migration: Phase 6 - Webhook Acknowledgment Policy Support
-- Purpose: Extend webhook_inbox to store acknowledgement metadata and enable policy-scoped settings.
-- Date: 2025-10-15

-- =============================================================================
-- Alter webhook_inbox to track acknowledgement metadata and policy references
-- =============================================================================

ALTER TABLE webhook_inbox
    ADD COLUMN ack_mode TEXT,
    ADD COLUMN ack_status_code INT,
    ADD COLUMN ack_headers JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN ack_body JSONB,
    ADD COLUMN ack_sent_at TIMESTAMPTZ,
    ADD COLUMN ack_outcome TEXT,
    ADD COLUMN ack_reason TEXT,
    ADD COLUMN ack_validation JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN idempotency_key TEXT,
    ADD COLUMN policy_scope_type TEXT,
    ADD COLUMN policy_scope_id UUID,
    ADD COLUMN policy_settings_id UUID REFERENCES settings(id),
    ADD COLUMN policy_version INT,
    ADD COLUMN workflow_followup_workflow_id UUID,
    ADD COLUMN workflow_followup_actions JSONB;

COMMENT ON COLUMN webhook_inbox.ack_mode IS 'Policy-driven acknowledgement mode (synchronous_success, accepted_async, policy_error, etc.).';
COMMENT ON COLUMN webhook_inbox.ack_status_code IS 'HTTP status code returned to webhook source (ack response).';
COMMENT ON COLUMN webhook_inbox.ack_headers IS 'Headers sent in acknowledgement response.';
COMMENT ON COLUMN webhook_inbox.ack_body IS 'Body payload sent in acknowledgement response.';
COMMENT ON COLUMN webhook_inbox.ack_sent_at IS 'Timestamp when acknowledgement was emitted.';
COMMENT ON COLUMN webhook_inbox.ack_outcome IS 'Result of acknowledgement processing (ack_sent, validation_failed, duplicate, etc.).';
COMMENT ON COLUMN webhook_inbox.ack_reason IS 'Optional diagnostic string detailing ack outcome.';
COMMENT ON COLUMN webhook_inbox.ack_validation IS 'Validation summary (HMAC, schema, idempotency) captured at ack time.';
COMMENT ON COLUMN webhook_inbox.idempotency_key IS 'Derived key used to deduplicate/replay-protect webhook acknowledgements.';
COMMENT ON COLUMN webhook_inbox.policy_scope_type IS 'Scope type (source, sender, client, tenant, global) that supplied the ingest policy.';
COMMENT ON COLUMN webhook_inbox.policy_scope_id IS 'Scope identifier whose policy resolved for this webhook (NULL for global).';
COMMENT ON COLUMN webhook_inbox.policy_settings_id IS 'settings.id for the resolved webhook_ingest_policy.';
COMMENT ON COLUMN webhook_inbox.policy_version IS 'settings_versions.version identifier used for this webhook run.';
COMMENT ON COLUMN webhook_inbox.workflow_followup_workflow_id IS 'Workflow template id executed after acknowledgement.';
COMMENT ON COLUMN webhook_inbox.workflow_followup_actions IS 'JSON array of configured workflow follow-up actions for worker execution.';

CREATE INDEX idx_webhook_inbox_idempotency_key ON webhook_inbox(idempotency_key);
CREATE INDEX idx_webhook_inbox_policy_settings ON webhook_inbox(policy_settings_id);

-- =============================================================================
-- Link webhook_sources to senders for scope-resolution ladder
-- =============================================================================

ALTER TABLE webhook_sources
    ADD COLUMN sender_id UUID REFERENCES senders(id);

COMMENT ON COLUMN webhook_sources.sender_id IS 'Optional sender mapped to this webhook source (enables sender/client scoped policies).';

CREATE INDEX idx_webhook_sources_sender_id ON webhook_sources(sender_id);

-- =============================================================================
-- Store acknowledgement history for auditability
-- =============================================================================

CREATE TABLE webhook_ack_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_inbox_id UUID NOT NULL REFERENCES webhook_inbox(id) ON DELETE CASCADE,
    webhook_source_id UUID NOT NULL REFERENCES webhook_sources(id),
    ack_mode TEXT,
    ack_status_code INT,
    ack_headers JSONB DEFAULT '{}'::jsonb,
    ack_body JSONB,
    ack_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ack_outcome TEXT,
    ack_reason TEXT,
    validation_results JSONB DEFAULT '{}'::jsonb,
    policy_settings_id UUID REFERENCES settings(id),
    policy_scope_type TEXT,
    policy_scope_id UUID,
    policy_version INT,
    idempotency_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_ack_history_source ON webhook_ack_history(webhook_source_id, ack_sent_at DESC);
CREATE INDEX idx_webhook_ack_history_policy ON webhook_ack_history(policy_settings_id);
CREATE INDEX idx_webhook_ack_history_idempotency ON webhook_ack_history(idempotency_key) WHERE idempotency_key IS NOT NULL;

COMMENT ON TABLE webhook_ack_history IS 'Immutable record of each acknowledgement emitted for inbound webhooks (validation + policy lineage).';
COMMENT ON COLUMN webhook_ack_history.validation_results IS 'Validation evidence captured during acknowledgement (HMAC, schema, replay checks).';

-- =============================================================================
-- Worker action handler registry (maps handler keys to plpgsql entrypoints)
-- =============================================================================

CREATE TABLE worker_action_handlers (
    handler_key TEXT PRIMARY KEY,
    function_name TEXT NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true
);

COMMENT ON TABLE worker_action_handlers IS 'Lookup table describing which database function executes a given workflow follow-up handler key.';
COMMENT ON COLUMN worker_action_handlers.function_name IS 'Fully-qualified function name to invoke for this handler.';

INSERT INTO worker_action_handlers (handler_key, function_name, description, is_active)
VALUES
    ('start_workflow', 'public.worker_action_start_workflow', 'Kick off workflow template using mapping-configured context', true),
    ('call_supplier_api', 'public.worker_action_call_supplier_api', 'Invoke outbound API call using call_api + mapping configs', true),
    ('enqueue_notification', 'public.worker_action_enqueue_notification', 'Enqueue notification job driven by comms policy', true),
    ('geocode_enrich', 'public.worker_action_geocode_enrich', 'Perform workflow follow-up geocode enrichment for shipment/address', true)
ON CONFLICT (handler_key) DO UPDATE
SET function_name = EXCLUDED.function_name,
    description = EXCLUDED.description,
    is_active = EXCLUDED.is_active;

-- =============================================================================
-- Extend resolve_settings to support resource-level scopes (e.g., webhook source)
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
    v_sender_id UUID;
BEGIN
    IF p_category IS NULL THEN
        RETURN NULL;
    END IF;

    IF p_scope_type IS NULL OR p_scope_type = '' THEN
        p_scope_type := 'global';
    ELSIF p_scope_type = 'organization' THEN
        p_scope_type := 'tenant';
    END IF;

    IF p_scope_type = 'global' THEN
        SELECT cached_value
        INTO v_value
        FROM settings
        WHERE category = p_category
          AND scope_type = 'global'
          AND scope_id IS NULL
        ORDER BY last_updated DESC
        LIMIT 1;
        RETURN v_value;
    END IF;

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

    IF p_scope_type = 'resource' THEN
        RETURN resolve_settings(p_category, 'global', NULL);
    ELSIF p_scope_type = 'source' THEN
        SELECT sender_id, organization_id
        INTO v_sender_id, v_org_id
        FROM webhook_sources
        WHERE id = p_scope_id;

        IF v_sender_id IS NOT NULL THEN
            v_value := resolve_settings(p_category, 'sender', v_sender_id);
            IF v_value IS NOT NULL THEN
                RETURN v_value;
            END IF;

            SELECT client_id INTO v_client_id FROM senders WHERE id = v_sender_id;
            IF v_client_id IS NOT NULL THEN
                v_value := resolve_settings(p_category, 'client', v_client_id);
                IF v_value IS NOT NULL THEN
                    RETURN v_value;
                END IF;
            END IF;
        END IF;

        IF v_client_id IS NULL AND v_sender_id IS NULL AND v_org_id IS NULL THEN
            SELECT organization_id INTO v_org_id FROM webhook_sources WHERE id = p_scope_id;
        END IF;

        IF v_org_id IS NOT NULL THEN
            v_value := resolve_settings(p_category, 'tenant', v_org_id);
            IF v_value IS NOT NULL THEN
                RETURN v_value;
            END IF;
        END IF;

        RETURN resolve_settings(p_category, 'global', NULL);
    ELSIF p_scope_type = 'sender' THEN
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
        RETURN resolve_settings(p_category, 'global', NULL);
    END IF;
END;
$$;

COMMENT ON FUNCTION resolve_settings(TEXT, TEXT, UUID)
    IS 'Resolve configuration value using override ladder including resource scope -> sender -> client -> tenant -> global.';

-- =============================================================================
-- Helper: resolve_webhook_ingest_policy
-- =============================================================================

CREATE OR REPLACE FUNCTION resolve_webhook_ingest_policy(
    p_webhook_source_id UUID
)
RETURNS TABLE (
    settings_id UUID,
    settings_version_id UUID,
    scope_type TEXT,
    scope_id UUID,
    policy JSONB,
    policy_version INT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_sender_id UUID;
    v_client_id UUID;
    v_org_id UUID;
    v_rows INT;
BEGIN
    SELECT sender_id, organization_id
    INTO v_sender_id, v_org_id
    FROM webhook_sources
    WHERE id = p_webhook_source_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook source % not found', p_webhook_source_id;
    END IF;

    IF v_sender_id IS NOT NULL THEN
        SELECT client_id INTO v_client_id FROM senders WHERE id = v_sender_id;
    END IF;

    RETURN QUERY
    SELECT ranked.id,
           ranked.settings_version_id,
           ranked.scope_type,
           ranked.scope_id,
           ranked.policy,
           ranked.version
    FROM (
        SELECT s.id,
               s.settings_version_id,
               s.scope_type,
               s.scope_id,
               s.cached_value AS policy,
               sv.version,
               1 AS priority
        FROM settings s
        JOIN settings_versions sv ON sv.id = s.settings_version_id
        WHERE s.category = 'webhook_ingest_policy'
          AND s.scope_type = 'source'
          AND s.scope_id = p_webhook_source_id

        UNION ALL
        SELECT s.id,
               s.settings_version_id,
               s.scope_type,
               s.scope_id,
               s.cached_value,
               sv.version,
               2 AS priority
        FROM settings s
        JOIN settings_versions sv ON sv.id = s.settings_version_id
        WHERE s.category = 'webhook_ingest_policy'
          AND s.scope_type = 'sender'
          AND v_sender_id IS NOT NULL
          AND s.scope_id = v_sender_id

        UNION ALL
        SELECT s.id,
               s.settings_version_id,
               s.scope_type,
               s.scope_id,
               s.cached_value,
               sv.version,
               3 AS priority
        FROM settings s
        JOIN settings_versions sv ON sv.id = s.settings_version_id
        WHERE s.category = 'webhook_ingest_policy'
          AND s.scope_type = 'client'
          AND v_client_id IS NOT NULL
          AND s.scope_id = v_client_id

        UNION ALL
        SELECT s.id,
               s.settings_version_id,
               s.scope_type,
               s.scope_id,
               s.cached_value,
               sv.version,
               4 AS priority
        FROM settings s
        JOIN settings_versions sv ON sv.id = s.settings_version_id
        WHERE s.category = 'webhook_ingest_policy'
          AND s.scope_type = 'tenant'
          AND v_org_id IS NOT NULL
          AND s.scope_id = v_org_id

        UNION ALL
        SELECT s.id,
               s.settings_version_id,
               s.scope_type,
               s.scope_id,
               s.cached_value,
               sv.version,
               5 AS priority
        FROM settings s
        JOIN settings_versions sv ON sv.id = s.settings_version_id
        WHERE s.category = 'webhook_ingest_policy'
          AND s.scope_type = 'global'
          AND s.scope_id IS NULL
    ) ranked
    ORDER BY ranked.priority
    LIMIT 1;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
        RAISE EXCEPTION 'No webhook_ingest_policy found for webhook_source_id=%', p_webhook_source_id;
    END IF;
END;
$$;

COMMENT ON FUNCTION resolve_webhook_ingest_policy(UUID)
    IS 'Resolve webhook ingest policy + metadata using scope ladder (source → sender → client → tenant → global).';

-- =============================================================================
-- Helper: record_webhook_ack
-- =============================================================================

CREATE OR REPLACE FUNCTION record_webhook_ack(
    p_webhook_inbox_id UUID,
    p_webhook_source_id UUID,
    p_ack_mode TEXT,
    p_ack_status_code INT,
    p_policy_settings_id UUID,
    p_policy_scope_type TEXT,
    p_policy_scope_id UUID,
    p_policy_version INT,
    p_ack_headers JSONB DEFAULT '{}'::jsonb,
    p_ack_body JSONB DEFAULT NULL,
    p_ack_outcome TEXT DEFAULT 'ack_sent',
    p_ack_reason TEXT DEFAULT NULL,
    p_validation_results JSONB DEFAULT '{}'::jsonb,
    p_ack_sent_at TIMESTAMPTZ DEFAULT now(),
    p_idempotency_key TEXT DEFAULT NULL,
    p_workflow_followup_actions JSONB DEFAULT '[]'::jsonb,
    p_workflow_followup_workflow_id UUID DEFAULT NULL
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
        workflow_followup_actions = COALESCE(p_workflow_followup_actions, '[]'::jsonb),
        workflow_followup_workflow_id = p_workflow_followup_workflow_id
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
    ) VALUES (
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

COMMENT ON FUNCTION record_webhook_ack(UUID, UUID, TEXT, INT, UUID, TEXT, UUID, INT, JSONB, JSONB, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, JSONB, UUID)
    IS 'Atomic helper to persist acknowledgement metadata onto webhook_inbox and append webhook_ack_history.';

-- =============================================================================
-- Helper: create_ops_alert_for_webhook
-- =============================================================================

CREATE OR REPLACE FUNCTION create_ops_alert_for_webhook(
    p_organization_id UUID,
    p_webhook_inbox_id UUID,
    p_message TEXT DEFAULT 'Webhook acknowledgement issue detected.',
    p_context JSONB DEFAULT '{}'::jsonb,
    p_severity TEXT DEFAULT 'critical'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_rule_name TEXT;
    v_rule_id UUID;
    v_severity_lookup_id UUID;
    v_trigger_id UUID;
BEGIN
    IF p_organization_id IS NULL THEN
        RETURN NULL;
    END IF;

    v_rule_name := format('ops::%s::webhook_ack_guard', p_organization_id);

    SELECT id
    INTO v_rule_id
    FROM alert_rules
    WHERE rule_name = v_rule_name;

    IF v_rule_id IS NULL THEN
        SELECT lv.id
        INTO v_severity_lookup_id
        FROM lookup_values lv
        JOIN lookup_definitions ld ON ld.id = lv.lookup_definition_id
        WHERE ld.category = 'severity_level'
          AND lv.value = LOWER(COALESCE(p_severity, 'critical'))
        LIMIT 1;

        INSERT INTO alert_rules (
            organization_id,
            rule_name,
            enabled,
            priority,
            trigger_source,
            trigger_conditions,
            throttle_window_minutes,
            throttle_key_fields,
            alert_severity_lookup_id,
            alert_channels,
            message_template_id,
            message_variables,
            created_by
        )
        VALUES (
            p_organization_id,
            v_rule_name,
            TRUE,
            1000,
            'webhook_inbox',
            jsonb_build_object('reason', 'ack_guard'),
            5,
            jsonb_build_array('resource_id'),
            v_severity_lookup_id,
            jsonb_build_array('ops_webhook'),
            NULL,
            jsonb_build_object('resource_type', 'webhook_inbox'),
            NULL
        )
        RETURNING id INTO v_rule_id;
    END IF;

    INSERT INTO alert_triggers (
        alert_rule_id,
        organization_id,
        resource_type,
        resource_id,
        severity,
        message,
        context
    )
    VALUES (
        v_rule_id,
        p_organization_id,
        'webhook_inbox',
        p_webhook_inbox_id,
        COALESCE(p_severity, 'critical'),
        COALESCE(p_message, 'Webhook acknowledgement issue detected.'),
        COALESCE(p_context, '{}'::jsonb)
    )
    RETURNING id INTO v_trigger_id;

    RETURN v_trigger_id;
END;
$$;

COMMENT ON FUNCTION create_ops_alert_for_webhook(UUID, UUID, TEXT, JSONB, TEXT)
    IS 'Ensure an ops alert rule exists and append an alert_triggers entry for the specified webhook inbox record.';


